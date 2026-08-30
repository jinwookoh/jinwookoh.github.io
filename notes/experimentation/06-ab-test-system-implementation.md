---
title: "A/B 테스트 시스템 — Feature Flag와 실험 플랫폼 구현"
series: experimentation
part: "A/B 테스트"
order: 6
summary: "배정·플래그 평가·이벤트 추적·결과 집계를 분리해 A/B 테스트 플랫폼을 직접 구현하는 방법"
tags: [A/B 테스트, Feature Flag, 실험 플랫폼, 이벤트 추적, Spring Boot]
sources: [2026-05-03-ab-test-system.md, 2026-05-03-ab-test-implementation.md]
updated: 2026-08-30
---

가설과 지표가 정해져도 실험을 손으로 운영하면 곧 한계에 부딪힌다. 어떤 사용자가 어느 그룹에 들어갔는지, 지금 어떤 실험이 켜져 있는지, 전환 이벤트를 어디에 어떤 형식으로 쌓을지가 코드 곳곳에 흩어지고, 새로고침 한 번에 사용자가 다른 그룹으로 옮겨 가거나 같은 사용자가 두 번 집계되는 오류가 결과를 오염시킨다. Optimizely·VWO 같은 상용 도구가 내부에서 하는 일은 결국 배정, 플래그 평가, 이벤트 수집, 집계와 검정 네 가지이며, 이 네 가지를 분리해 작게 구현하면 실험 결과를 신뢰할 수 있는 최소 플랫폼이 된다.

## 핵심 개념

시스템은 세 층으로 나뉜다. 클라이언트는 사용자를 그룹에 배정하고 그 결과에 따라 화면을 분기하며 이벤트를 전송한다. 추적 서버는 이벤트를 받아 저장하고, 실험별로 그룹당 사용자 수와 전환 수를 집계해 검정 결과를 반환한다. 저장소는 이벤트 종류별로 분리된 append-only 로그다. 세 층을 나누면 프론트엔드 프레임워크나 상태 관리 라이브러리를 바꿔도 실험 로직은 그대로 남는다.

실험 로직의 핵심은 두 연산의 분리다. 활성화(activate)는 타겟팅 조건을 확인하고 사용자를 변형(variation)에 배정한 뒤 `Bucket` 이벤트를 기록한다. 실행(run)은 이미 배정된 변형을 조회해 호출자에게 돌려준다. 실행이 배정 결과를 찾지 못하면 null 또는 false를 반환하고, 호출자는 이 경우를 항상 원본(original) 분기로 처리한다. 실험이 꺼져 있거나 초기화가 끝나지 않은 순간에도 화면이 깨지지 않게 하는 안전장치다.

배정은 결정적이어야 한다. ==매 요청마다 난수를 뽑으면 재방문 시 그룹이 바뀌고 같은 사용자가 두 그룹에 동시에 잡힌다.== 실험 키와 사용자 식별자를 이어 붙여 해시한 뒤 버킷 범위로 나누면 같은 사용자는 언제나 같은 변형을 받고, 서버가 상태를 들고 있을 필요도 없다. 사용자 식별자는 로그인 전에는 브라우저 저장소에 보관한 UUID를 쓰고, 로그인 후에는 계정 ID로 연결한다.

변형이 돌려주는 값의 형태는 네 가지로 정리된다.

| 패턴 | 반환값 | 용도 |
|---|---|---|
| Boolean | true/false | 새 기능 노출 여부 |
| 데이터 변환 | 입력을 가공한 값 | 리뷰 정렬 순서 변경 |
| 조건부 Boolean | 데이터에 따른 true/false | 재고 10개 미만일 때만 경고 |
| 데이터 주입 | 변형별 다른 콘텐츠 | 결제 완료 페이지의 추천 목록 |

이벤트 저장은 종류별 파일 또는 테이블로 분리한다. `Bucket`은 실험명과 변형을, `purchase`는 사용자와 시각만 담는 식으로 스키마가 달라도 서로 간섭하지 않고, 분석 시 필요한 이벤트만 읽는다. 타임스탬프는 클라이언트가 보낸 값을 버리고 서버가 수신 시각으로 기록한다.

집계는 `Bucket`에서 해당 실험의 행만 골라 사용자 식별자로 중복을 제거하고, 변형별 사용자 수를 센 뒤 지표 이벤트를 남긴 사용자 집합과 교집합을 구해 전환 수를 얻는다. 변형별 `[사용자 수, 전환 수]` 표를 카이제곱 검정에 넣으면 유의성이 나온다.

## 코드

실험 정의와 해시 기반 결정적 배정 서비스다. 같은 실험 키와 사용자 ID 조합은 항상 같은 변형을 받는다.

```java
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.List;
import java.util.Optional;
import org.springframework.stereotype.Service;

public record Experiment(String key, boolean active, List<String> variations,
                         Optional<String> pathPattern) {}

@Service
public class AssignmentService {

    private final ExperimentRegistry registry;
    private final EventStore events;

    public AssignmentService(ExperimentRegistry registry, EventStore events) {
        this.registry = registry;
        this.events = events;
    }

    public Optional<String> activate(String experimentKey, String userId, String path) {
        Experiment exp = registry.find(experimentKey).orElse(null);
        if (exp == null || !exp.active()) return Optional.empty();
        if (exp.pathPattern().map(p -> !path.matches(p)).orElse(false)) return Optional.empty();

        String variation = exp.variations().get(bucket(experimentKey, userId, exp.variations().size()));
        events.append("Bucket", userId, List.of(experimentKey, variation));
        return Optional.of(variation);
    }

    static int bucket(String experimentKey, String userId, int size) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256")
                    .digest((experimentKey + ":" + userId).getBytes(StandardCharsets.UTF_8));
            long head = Long.parseUnsignedLong(HexFormat.of().formatHex(digest, 0, 7), 16);
            return (int) (head % size);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }
}
```

이벤트 수신과 저장 컨트롤러다. 타임스탬프는 서버에서 찍고, 이벤트 이름별로 다른 파일에 append한다.

```java
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.time.Instant;
import java.util.List;
import java.util.concurrent.locks.ReentrantLock;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Component;
import org.springframework.web.bind.annotation.*;

public record TrackRequest(String uuid, String event, List<String> data) {}

@Component
public class EventStore {
    private final Path dir = Path.of("data");
    private final ReentrantLock lock = new ReentrantLock();

    public void append(String event, String uuid, List<String> data) {
        if (!event.matches("[A-Za-z0-9_ ]+")) throw new IllegalArgumentException("invalid event");
        String row = uuid + "," + event + "," + Instant.now().toEpochMilli()
                + (data.isEmpty() ? "" : "," + String.join(",", data)) + "\n";
        lock.lock();
        try {
            Files.createDirectories(dir);
            Files.writeString(dir.resolve(event + ".csv"), row, StandardCharsets.UTF_8,
                    StandardOpenOption.CREATE, StandardOpenOption.APPEND);
        } catch (IOException e) {
            throw new IllegalStateException(e);
        } finally {
            lock.unlock();
        }
    }
}

@RestController
@CrossOrigin(origins = "${experiment.allowed-origin}")
public class TrackController {
    private final EventStore store;

    public TrackController(EventStore store) { this.store = store; }

    @PostMapping("/track")
    public ResponseEntity<Void> track(@RequestBody TrackRequest req) {
        if (req.uuid() == null || req.event() == null) return ResponseEntity.badRequest().build();
        store.append(req.event(), req.uuid(), req.data() == null ? List.of() : req.data());
        return ResponseEntity.accepted().build();
    }
}
```

결과 집계다. 실험별 `Bucket` 행에서 사용자 중복을 제거하고 변형별 사용자 수와 전환 수를 세어 2×2 카이제곱 통계량을 계산한다.

```java
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.*;
import org.springframework.web.bind.annotation.*;

public record VariationResult(long users, long conversions, double conversionRate) {}
public record ExperimentResult(double chiSquare, Map<String, VariationResult> results) {}

@RestController
public class ResultsController {
    private final Path dir = Path.of("data");

    @GetMapping("/results")
    public ExperimentResult results(@RequestParam String experiment,
                                    @RequestParam String metric) throws IOException {
        Set<String> converted = new HashSet<>();
        Path metricFile = dir.resolve(metric + ".csv");
        if (Files.exists(metricFile)) {
            for (String row : Files.readAllLines(metricFile)) {
                if (!row.isBlank()) converted.add(row.split(",")[0]);
            }
        }

        Map<String, long[]> counts = new LinkedHashMap<>();
        Set<String> seen = new HashSet<>();
        for (String row : Files.readAllLines(dir.resolve("Bucket.csv"))) {
            if (row.isBlank()) continue;
            String[] f = row.split(",");
            if (f.length < 5 || !f[3].equals(experiment) || !seen.add(f[0])) continue;
            long[] c = counts.computeIfAbsent(f[4], k -> new long[2]);
            c[0]++;
            if (converted.contains(f[0])) c[1]++;
        }

        Map<String, VariationResult> out = new LinkedHashMap<>();
        counts.forEach((v, c) -> out.put(v,
                new VariationResult(c[0], c[1], c[0] == 0 ? 0 : (double) c[1] / c[0])));
        return new ExperimentResult(chiSquare(counts.values()), out);
    }

    static double chiSquare(Collection<long[]> groups) {
        long users = 0, conv = 0;
        for (long[] g : groups) { users += g[0]; conv += g[1]; }
        if (users == 0 || conv == 0 || conv == users) return 0;
        double p = (double) conv / users, stat = 0;
        for (long[] g : groups) {
            double expConv = g[0] * p, expNo = g[0] * (1 - p);
            stat += Math.pow(g[1] - expConv, 2) / expConv
                  + Math.pow((g[0] - g[1]) - expNo, 2) / expNo;
        }
        return stat;
    }
}
```

두 변형이면 자유도 1이며 통계량이 3.84를 넘으면 95%, 6.63을 넘으면 99% 수준에서 유의하다. 변형이 셋 이상이면 자유도가 늘어나므로 임계값을 그에 맞게 읽는다.

## 실무에서 걸리는 지점

- **CORS 누락.** ==프론트엔드와 추적 서버가 다른 origin에서 뜨면 브라우저가 요청을 차단하고 모든 이벤트가 조용히 사라진다.== 개발 환경에서는 전체 허용이 편하지만 운영에서는 `@CrossOrigin` 또는 `CorsConfigurationSource`로 허용 origin을 명시적으로 제한한다.
- **중복 집계.** 새로고침마다 `Bucket` 이벤트가 다시 기록되므로 집계 단계에서 사용자 식별자로 반드시 중복을 제거한다. 배정을 해시로 결정적으로 만들면 중복 행이 있어도 변형은 같으므로 결과가 흔들리지 않는다.
- **추적 호출이 사용자 동작을 막는 문제.** ==클라이언트의 `track`은 실패를 삼키고 응답을 기다리지 않아야 한다.== 추적 서버가 죽어도 구매 흐름은 이어져야 하며, 서버 쪽도 저장 실패를 4xx·5xx로 노출하기보다 로그로 남기고 202를 반환하는 편이 낫다.
- **평가 순서 경쟁.** 자식 컴포넌트가 실험 값을 읽는 시점이 부모의 활성화보다 빠르면 null이 돌아온다. 실험 값을 렌더 최상단에서 읽고 그 값을 effect 의존성에 넣어 값이 준비되면 재실행되게 하거나, 활성화를 앱 부트스트랩에서 동기적으로 끝낸 뒤 화면을 그린다.
- **파일 append의 한계.** ==CSV는 MVP에 적합하지만 다중 인스턴스에서는 잠금이 통하지 않고 파일 끝의 빈 줄이나 값 안의 쉼표가 파싱을 깨뜨린다.== 트래픽이 늘면 PostgreSQL이나 ClickHouse 같은 저장소로 옮기고, 이벤트 이름은 파일 경로로 쓰이므로 허용 문자를 검증해 경로 조작을 막는다.

## 관련 글

- [A/B 테스트 — 대조군·전환율·가설과 지표 설계](/notes/experimentation/ab-test-basics-design/)
- [A/B 테스트 통계 — 카이제곱·베이지안·다중 비교](/notes/experimentation/ab-test-statistics/)
- [A/B 테스트 베스트 프랙티스와 사례](/notes/experimentation/ab-test-best-practices-cases/)
