---
title: "EC2·EBS·EFS"
series: aws
part: "컴퓨트와 스토리지"
order: 3
summary: "EC2 인스턴스 선택·구매 옵션·생명주기와 EBS·EFS·Instance Store를 워크로드 기준으로 고르는 규칙을 정리한다."
tags: [EC2, EBS, EFS, AMI, Instance Store]
sources: [2026-05-01-aws-saa-ec2-storage.md, 2026-05-03-aws-dva-compute.md]
updated: 2026-08-30
---

물리 서버 위에 서비스를 올리면 용량 산정과 장비·디스크 장애 대응을 직접 감당해야 하고, 트래픽이 줄어도 장비 비용은 그대로 남는다. EC2는 가상 서버를 초 단위로 빌려 이 문제를 없애지만, 인스턴스에 직결된 디스크는 인스턴스와 함께 사라지고 여러 인스턴스가 같은 파일을 봐야 하는 경우도 있다. ==EC2 본체와 EBS·EFS·Instance Store의 역할을 구분해야 비용과 내구성 요구를 동시에 맞출 수 있다.==

## 핵심 개념

### 인스턴스 타입

`m5.2xlarge`는 패밀리(m), 세대(5), 크기(2xlarge)로 읽는다. 세대가 높을수록 신형 하드웨어를 쓰고, 크기는 한 단계마다 vCPU·메모리가 두 배씩 커진다. 패밀리는 워크로드로 고른다. T·M은 범용, C는 CPU 집약, R·X는 메모리 집약, I·D는 로컬 디스크 I/O, P·G·Inf는 GPU·가속기 워크로드다.

### 구매 옵션

가격 모델은 약정 기간과 중단 허용 여부로 갈린다.

| 옵션 | 약정 | 할인 | 적합한 워크로드 |
|:---|:---|:---|:---|
| On-Demand | 없음 | 없음 | 단기, 예측 불가 |
| Reserved (Standard/Convertible) | 1·3년, 타입 고정 | 최대 72% / 66% | 상시 가동 DB·백엔드 |
| Savings Plans | 1·3년, 시간당 금액만 약정 | 최대 72% | 타입 변경 여지가 있는 안정 워크로드 |
| Spot | 없음, 2분 통보 후 회수 | 최대 90% | 배치, 분석, CI, ML 학습 |
| Dedicated Hosts | 물리 서버 단위 | - | 소켓·코어 기반 BYOL, 물리 격리 규제 |

### 생명주기

==User Data는 최초 부팅 시 루트 권한으로 한 번만 실행된다.== 재부팅에는 실행되지 않으므로 매 부팅마다 필요한 작업은 systemd 유닛으로 등록한다. Stop/Start 시 퍼블릭 IPv4는 바뀌고 프라이빗 IP는 유지되며, Reboot는 둘 다 유지한다.

AMI는 OS·소프트웨어·설정과 EBS 스냅샷을 묶은 인스턴스 템플릿이다. 미리 설치를 마친 Golden AMI는 Auto Scaling 시 부팅이 훨씬 빠르다. 리전에 종속되므로 다른 리전에서는 복사해서 쓴다.

### 보안 그룹과 배치

보안 그룹은 인스턴스 밖에서 동작하는 상태 저장 방화벽이다. 허용 규칙만 정의할 수 있고 인바운드는 기본 차단, 아웃바운드는 기본 허용이며, 소스로 다른 보안 그룹을 참조할 수 있다. ==접속이 타임아웃이면 보안 그룹, Connection Refused면 애플리케이션 문제다.== Placement Group은 Cluster(저지연 집중)·Spread(랙 분산, AZ당 7대)·Partition(대규모 분산 시스템) 중 고른다.

### EBS

EBS는 네트워크로 연결되는 블록 스토리지이며 특정 AZ에 묶인다. 다른 AZ·리전으로 옮기려면 스냅샷에서 새 볼륨을 만든다.

| 타입 | 최대 IOPS | 부팅 | 특징 |
|:---|:---|:---|:---|
| gp3 | 16,000 | 가능 | IOPS·처리량을 크기와 독립 설정 |
| gp2 | 16,000 | 가능 | 1GB당 3 IOPS로 크기에 연동 |
| io1 / io2 | 64,000 / 256,000 | 가능 | Multi-Attach 지원, 미션 크리티컬 DB |
| st1 | 500 | 불가 | 로그, 빅데이터 순차 읽기 |
| sc1 | 250 | 불가 | 아카이브, 최저 비용 |

비암호화 볼륨은 스냅샷을 암호화 옵션으로 복사한 뒤 새 볼륨으로 교체한다. Multi-Attach는 io1/io2를 같은 AZ의 인스턴스 최대 16대에 붙이며 클러스터 인식 파일 시스템이 필요하다.

### EBS·EFS·Instance Store

| 구분 | EBS | EFS | Instance Store |
|:---|:---|:---|:---|
| 유형 | 블록(네트워크) | 파일, NFS | 블록(물리 직결) |
| 연결·범위 | 1:1, 단일 AZ | 1:N, 다중 AZ | 인스턴스 1대 |
| OS | Linux·Windows | Linux | Linux·Windows |
| 영속성 | 영구 | 영구 | Stop·Terminate 시 삭제, Reboot는 유지 |
| 용도 | DB, 범용 디스크 | 공유 파일, 웹 콘텐츠 | 캐시, 버퍼, 스크래치 |

EFS 처리량 모드는 예측 불가능한 워크로드에 Elastic이 권장되고, 수명 주기 정책으로 미접근 파일을 IA·Archive 클래스로 내리면 비용이 크게 준다. Windows 공유 파일 시스템은 FSx를 쓴다.

## 코드

Spring Boot 3 실행 JAR를 최초 부팅 시 설치하고 systemd 서비스로 등록하는 User Data 스크립트다. 서비스로 등록해야 재부팅 후에도 애플리케이션이 다시 뜬다.

```bash
#!/bin/bash
dnf install -y java-21-amazon-corretto-headless
mkdir -p /opt/app
aws s3 cp s3://my-artifacts/app.jar /opt/app/app.jar
cat > /etc/systemd/system/app.service <<'EOF'
[Unit]
Description=Spring Boot App
After=network.target

[Service]
User=ec2-user
ExecStart=/usr/bin/java -jar /opt/app/app.jar
Restart=always

[Install]
WantedBy=multi-user.target
EOF
systemctl enable --now app
```

IMDSv2로 인스턴스 ID와 AZ를 읽는 컴포넌트다. 토큰 발급 후 조회하는 두 단계를 `RestClient`로 구현한다.

```java
@Component
public class InstanceMetadata {

    private final RestClient client =
            RestClient.builder().baseUrl("http://169.254.169.254/latest").build();

    public record Info(String instanceId, String availabilityZone) {}

    public Info load() {
        String token = client.put()
                .uri("/api/token")
                .header("X-aws-ec2-metadata-token-ttl-seconds", "21600")
                .retrieve()
                .body(String.class);
        return new Info(get(token, "/meta-data/instance-id"),
                        get(token, "/meta-data/placement/availability-zone"));
    }

    private String get(String token, String path) {
        return client.get()
                .uri(path)
                .header("X-aws-ec2-metadata-token", token)
                .retrieve()
                .body(String.class);
    }
}
```

EFS 마운트 지점에 여러 인스턴스가 동시에 쓰는 업로드 저장소다. 파일명 충돌을 피하기 위해 UUID를 붙인다.

```java
@Service
public class SharedFileStore {

    private final Path root;

    public SharedFileStore(@Value("${app.efs.mount:/mnt/efs/uploads}") String mount) throws IOException {
        this.root = Files.createDirectories(Path.of(mount));
    }

    public Path save(MultipartFile file) throws IOException {
        Path target = root.resolve(UUID.randomUUID() + "-" + file.getOriginalFilename());
        try (InputStream in = file.getInputStream()) {
            Files.copy(in, target, StandardCopyOption.REPLACE_EXISTING);
        }
        return target;
    }
}
```

## 실무에서 걸리는 지점

- ==**Instance Store에 영속 데이터를 두는 사고.** 로컬 NVMe는 Stop·Terminate·하드웨어 장애 시 사라진다.== 캐시·임시 파일에만 쓰고 DB 파일은 EBS에 둔다.
- **gp2 IOPS 부족을 용량 증설로 푸는 낭비.** gp3로 바꾸면 크기와 무관하게 IOPS·처리량을 설정할 수 있고 단가도 낮다.
- **스냅샷에서 만든 볼륨의 초기 성능 저하.** 블록을 처음 읽을 때 S3에서 지연 로딩하므로 직후 벤치마크가 낮게 나온다. 전체 블록을 한 번 읽어 워밍하거나 Fast Snapshot Restore를 켠다.
- **Persistent Spot 요청 정리 순서.** 인스턴스만 종료하면 요청이 살아 있어 새 인스턴스가 다시 뜬다. 요청 취소 후 종료한다.
- **EFS 소파일 대량 I/O와 포트.** NFS 메타데이터 지연이 커서 수만 개 소파일을 자주 여닫는 워크로드는 느리다. 보안 그룹의 2049 포트가 막히면 마운트가 타임아웃으로 실패한다.

## 관련 글

- [ELB와 Auto Scaling](/notes/aws/elb-autoscaling/)
- [IAM·STS·Cognito — 사용자·역할·정책](/notes/aws/iam-sts-cognito/)
- [S3 — 버킷·버전 관리·암호화·버킷 정책](/notes/aws/s3-basics-security/)
