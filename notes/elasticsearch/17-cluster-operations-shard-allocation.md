---
title: "클러스터 운영과 Shard Allocation"
series: elasticsearch
part: "운영"
order: 17
summary: "master 정족수·rolling restart·decommission 절차와 awareness·filtering·watermark로 샤드 배치를 제어하는 방법"
tags: [Elasticsearch, Shard Allocation, Rolling Restart, Split-Brain, Disk Watermark]
sources: [elasticsearch/2026-05-19-elasticsearch-cluster-operations.md, elasticsearch/2026-05-19-elasticsearch-shard-allocation.md]
updated: 2026-08-29
---

단일 노드 Elasticsearch는 노드 하나의 장애가 곧 서비스 장애다. 노드를 늘리면 네트워크 파티션과 master 선출 실패, 샤드 미할당 문제가 따라온다. primary와 replica가 같은 가용 영역에 놓이면 replica는 의미가 없고, 디스크가 찬 노드에 샤드가 계속 들어오면 인덱스가 read-only로 잠긴다. ==클러스터 운영은 정족수와 재시작 절차로 클러스터를 지키고, shard allocation은 샤드를 어디에 둘지 제어한다.==

## 핵심 개념

### 노드 역할과 master 정족수

`node.roles`로 `master`·`data`·`ingest` 등 역할을 지정한다. 소규모는 모든 역할을 합친 노드 3대로 시작해도 되지만, 규모가 커지면 master 전용 3대를 분리한다. master가 data 역할과 겹치면 집계가 유발하는 GC pause를 다른 노드가 장애로 판단해 재선출이 반복된다.

선출 정족수는 voting configuration의 노드 수 N에 대해 (N/2)+1이다. ==N=2면 한 대만 죽어도 선출이 불가능하므로 master-eligible은 3 또는 5로 두고 가용 영역에 분산한다.== `cluster.initial_master_nodes`는 최초 bootstrap 전용이며, 기존 클러스터에 노드를 추가할 때 넣으면 별도 클러스터가 형성되어 split-brain의 원인이 된다. 7.x 이전의 `discovery.zen.*` 설정은 8.x에서 시작을 거부하므로 제거한다.

```yaml
# master 전용 노드
node.name: master-1
node.roles: [master]
discovery.seed_hosts: ["master-1:9300", "master-2:9300", "master-3:9300"]
cluster.initial_master_nodes: ["master-1", "master-2", "master-3"]   # 최초 부트스트랩 때만

# 뒤에 추가하는 data 노드 — initial_master_nodes 없음
node.name: data-3
node.roles: [data, ingest]
node.attr.zone: zone-c
discovery.seed_hosts: ["master-1:9300", "master-2:9300", "master-3:9300"]
```

### Cluster Health와 Rolling Restart

`_cluster/health`의 green은 모든 샤드가 active, yellow는 일부 replica 미할당, red는 일부 primary 미할당이다. yellow는 재시작 중에는 정상이지만, red는 해당 샤드를 읽지도 쓰지도 못하므로 즉시 대응한다. 원인은 `_cluster/allocation/explain`으로 확인한다.

무중단 업그레이드는 rolling restart로 처리한다. `cluster.routing.allocation.enable`을 `primaries`로 바꿔 replica 재배치를 멈추고, `POST /_flush` 후 노드를 재시작하며, green이 될 때까지 기다린 뒤 설정을 `null`로 되돌린다. green 대기 없이 다음 노드를 끄면 어떤 인덱스의 모든 복사본이 동시에 사라져 red가 된다.

### 노드 제거와 Voting Exclusion

노드를 그냥 끄면 replica가 1인 데이터가 손실 위험에 노출된다. `cluster.routing.allocation.exclude._name`으로 샤드를 먼저 빼내고 `_cat/allocation`에서 0을 확인한 뒤 종료한다. master-eligible 노드는 `POST /_cluster/voting_config_exclusions?node_names=<name>`으로 voting configuration에서도 빼고, 작업 후 `DELETE`로 초기화한다.

### Shard Allocator의 결정 순서

master 안의 shard allocator가 `allocation.enable` → filtering → awareness → disk watermark 순으로 후보 노드를 걸러 배치를 결정한다.

**Awareness**는 장애 도메인 분산이다. 노드에 `node.attr.zone`을 두고 `cluster.routing.allocation.awareness.attributes: zone`을 지정하면 같은 zone에 동일 샤드의 primary와 replica가 함께 놓이지 않는다. zone 하나가 죽으면 기본 동작은 남은 zone에 replica를 다시 만들어 부하가 급증하는데, `awareness.force.zone.values`에 zone 값을 전부 적어 두면 재배치하지 않고 yellow를 유지한다.

**Filtering**은 인덱스를 특정 노드 그룹에 고정한다. `include`는 하나라도 일치하면 허용, `exclude`는 일치하면 거부, `require`는 모두 일치해야 허용한다.

**Disk watermark**는 low(85%)에서 새 샤드 할당을 멈추고, high(90%)에서 기존 샤드를 옮기며, flood_stage(95%)에서 인덱스에 `read_only_allow_delete` 블록을 건다.

primary shard 수를 바꾸려면 원본을 `index.blocks.write: true`로 잠근 뒤 shrink(약수)·split(배수)·clone으로 새 인덱스를 만들고 alias를 전환한다.

## 코드

rolling restart 전후의 allocation 토글과 green 대기를 Java API Client로 자동화한다.

```java
import co.elastic.clients.elasticsearch.ElasticsearchClient;
import co.elastic.clients.elasticsearch._types.HealthStatus;
import co.elastic.clients.elasticsearch._types.Time;
import co.elastic.clients.elasticsearch.cluster.HealthResponse;
import co.elastic.clients.json.JsonData;
import org.springframework.stereotype.Service;

@Service
public class RollingRestartService {

    private final ElasticsearchClient client;

    public RollingRestartService(ElasticsearchClient client) {
        this.client = client;
    }

    public void beforeNodeRestart() throws Exception {
        client.cluster().putSettings(s -> s
            .persistent("cluster.routing.allocation.enable", JsonData.of("primaries")));
        client.indices().flush(f -> f);
    }

    public void afterNodeRestart() throws Exception {
        HealthResponse health = client.cluster().health(h -> h
            .waitForStatus(HealthStatus.Green)
            .timeout(Time.of(t -> t.time("10m"))));
        if (health.timedOut()) {
            throw new IllegalStateException("cluster did not reach green within 10m");
        }
        client.cluster().putSettings(s -> s
            .persistent("cluster.routing.allocation.enable", JsonData.of(null)));
    }
}
```

decommission 시 exclude를 걸고 샤드가 0이 될 때까지 폴링한다.

```java
import co.elastic.clients.elasticsearch.ElasticsearchClient;
import co.elastic.clients.elasticsearch.cat.ShardsResponse;
import co.elastic.clients.json.JsonData;
import java.time.Duration;
import org.springframework.stereotype.Service;

@Service
public class DecommissionService {

    private final ElasticsearchClient client;

    public DecommissionService(ElasticsearchClient client) {
        this.client = client;
    }

    public void drain(String nodeName) throws Exception {
        client.cluster().putSettings(s -> s
            .transient_("cluster.routing.allocation.exclude._name", JsonData.of(nodeName)));

        while (true) {
            ShardsResponse shards = client.cat().shards(s -> s.h("index", "shard", "prirep", "state", "node"));
            long remaining = shards.valueBody().stream()
                .filter(r -> nodeName.equals(r.node()))
                .count();
            if (remaining == 0) {
                break;
            }
            Thread.sleep(Duration.ofSeconds(10));
        }
    }

    public void cleanup() throws Exception {
        client.cluster().putSettings(s -> s
            .transient_("cluster.routing.allocation.exclude._name", JsonData.of(null)));
    }
}
```

클러스터 생성 직후 awareness와 보수적 watermark를 적용한다.

```java
import co.elastic.clients.elasticsearch.ElasticsearchClient;
import co.elastic.clients.json.JsonData;
import org.springframework.boot.ApplicationRunner;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class AllocationBootstrapConfig {

    @Bean
    ApplicationRunner allocationSettings(ElasticsearchClient client) {
        return args -> client.cluster().putSettings(s -> s
            .persistent("cluster.routing.allocation.awareness.attributes", JsonData.of("zone"))
            .persistent("cluster.routing.allocation.awareness.force.zone.values", JsonData.of("zone-a,zone-b,zone-c"))
            .persistent("cluster.routing.allocation.disk.watermark.low", JsonData.of("80%"))
            .persistent("cluster.routing.allocation.disk.watermark.high", JsonData.of("85%"))
            .persistent("cluster.routing.allocation.disk.watermark.flood_stage", JsonData.of("90%")));
    }
}
```

## 실무에서 걸리는 지점

- ==**master-eligible 1~2대.** 1대는 장애가 클러스터 정지로 이어지고, 2대는 한 대만 죽어도 정족수를 잃는다.== 규모가 작아도 3대에 둔다.
- **decommission 시 샤드가 빠지지 않음.** 다른 노드가 high watermark에 걸리면 exclude를 걸어도 샤드가 남는다. 필요하면 watermark를 임시 상향한 뒤 원복한다.
- **exclude·voting exclusion 미정리.** 남은 exclude는 같은 이름의 새 노드에 샤드가 들어오지 않게 하고, 남은 voting exclusion은 정족수를 어긋나게 한다. 작업 마지막에 반드시 해제한다.

## 관련 글

- [Index 관리·ILM·Rollover](/notes/elasticsearch/index-management-ilm/)
- [Snapshot·Restore와 보안 (RBAC)](/notes/elasticsearch/snapshot-security/)
- [성능 튜닝](/notes/elasticsearch/performance-tuning/)
