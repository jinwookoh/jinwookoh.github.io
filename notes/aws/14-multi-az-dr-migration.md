---
title: "Multi-AZ 아키텍처·DR·마이그레이션"
series: aws
part: "운영"
order: 14
summary: "단일 장애점을 제거하는 Multi-AZ 설계 원칙과 RPO·RTO 기준의 DR 4전략, DMS·MGN·Snowball 마이그레이션 조합을 정리한다"
tags: [Multi-AZ, DR, DMS, AWS Backup, Migration]
sources: [2026-05-01-aws-saa-architectures.md, 2026-05-01-aws-saa-dr-migration.md]
updated: 2026-08-30
---

EC2 한 대에 애플리케이션과 세션과 데이터를 모두 올리면 인스턴스 재시작 한 번에 서비스가 멈추고, AZ 하나의 장애가 곧 전체 장애가 된다. 리전 단위 재해와 온프레미스 이전까지 고려하면 허용 가능한 데이터 손실과 다운타임을 먼저 숫자로 정해야 한다. 이 숫자가 없으면 백업 주기도 대기 인프라 규모도 근거 없이 결정된다.

## 핵심 개념

### Multi-AZ 설계 원칙

AZ는 리전 안에서 전원과 네트워크가 독립된 데이터센터 묶음이다. 고가용성은 ELB·ASG·RDS·ElastiCache를 모두 두 개 이상의 AZ에 배치하는 데서 시작한다. 이때 지켜야 할 규칙은 네 가지다.

- Route 53에서 ELB·CloudFront처럼 IP가 바뀌는 AWS 리소스를 가리킬 때는 A 레코드가 아니라 Alias 레코드를 쓴다.
- 보안 그룹 인바운드 소스는 IP가 아니라 상위 계층의 SG ID로 지정한다. 오토스케일링으로 IP가 바뀌어도 규칙을 수정하지 않는다.
- EC2는 무상태로 유지하고 세션은 ElastiCache 또는 DynamoDB에 둔다. 스티키 세션은 인스턴스 장애 시 사라지고 쿠키는 4KB 제한과 변조 위험이 있다.
- 여러 AZ의 EC2가 공유하는 파일은 EBS가 아니라 EFS에 둔다.

RDS Multi-AZ는 동기 복제와 자동 페일오버로 가용성을 확보하고, Read Replica는 비동기 복제로 읽기 부하를 분산한다. 리전을 넘는 관계형 DB는 Aurora Global Database를 쓴다. 단일 EC2를 다른 AZ로 페일오버하려면 두 AZ에 걸친 ASG(용량 1)에서 User Data가 EIP를 재연결하게 하고, Stateful 워크로드는 Lifecycle Hook에서 EBS 스냅샷을 찍어 새 AZ에 복원한다.

### RPO·RTO와 DR 4전략

RPO는 허용하는 데이터 손실 시간이고 백업 빈도로 결정된다. RTO는 허용하는 다운타임이고 대기 인프라 규모로 결정된다. 둘 다 줄일수록 비용이 급격히 증가하므로 DR 전략은 비용 제약 아래에서 고른다.

| 전략 | 평시 상태 | RTO | 비용 |
|:---|:---|:---|:---|
| Backup & Restore | 데이터 백업만 존재 | 수 시간~수 일 | 최저 |
| Pilot Light | DB만 실행, EC2 없음 | 수십 분 | 낮음 |
| Warm Standby | 전체 스택을 최소 규모로 실행 | 수 분 | 높음 |
| Multi-Site (Active-Active) | 두 리전 모두 프로덕션 규모 | 거의 0 | 최고 |

Pilot Light와 Warm Standby의 차이는 EC2가 꺼져 있는지 최소 규모로 켜져 있는지 하나다. Multi-Site는 Route 53 라우팅과 Aurora Global Database를 결합하고, Direct Connect의 백업 경로는 Site-to-Site VPN으로 둔다.

AWS Elastic Disaster Recovery(DRS)는 에이전트로 블록 수준 지속 복제를 하며 저사양 스테이징을 유지하다 재해 시 수 분 안에 프로덕션 규모 EC2로 전환한다(RPO 초, RTO 분 단위). AWS Backup은 여러 서비스의 백업을 태그 기반으로 중앙 관리하며, Vault Lock은 WORM 모델을 강제해 루트 사용자조차 백업을 삭제하거나 보존 기간을 줄일 수 없게 한다.

### 마이그레이션 도구 분류

무엇을 옮기느냐로 도구가 갈린다. DB는 DMS가 기본이며 Full Load + CDC로 소스 DB를 계속 쓰면서 이전한다. 엔진이 다르면 SCT로 스키마를 먼저 변환한다. 서버 자체는 MGN으로 에이전트 기반 Lift-and-Shift를 하고, 사전 계획은 Discovery Service(Agent-based만 종속성 매핑 제공), 진행 추적은 Migration Hub가 맡는다. MGN은 컷오버로 끝나는 일회성 이전이고 DRS는 페일백까지 포함한 지속 복구다.

파일은 DataSync가 온프레미스 NFS·SMB와 S3·EFS·FSx를 동기화하고, SFTP 워크플로 유지가 필요하면 Transfer Family를 쓴다. 200TB 기준 100Mbps 인터넷은 약 185일, 1Gbps Direct Connect는 약 18일, Snowball은 약 1주가 걸리므로 대역폭이 부족하면 Snowball로 초기 데이터를 보내고 배송 기간의 증분은 DMS CDC로 동기화한 뒤 컷오버한다. RDS에서 Aurora로는 Read Replica 지연이 0이 된 뒤 승격하고, 외부 MySQL은 Percona XtraBackup, 외부 PostgreSQL은 `aws_s3` 확장으로 가져온다.

## 코드

EC2를 무상태로 만들기 위해 세션을 ElastiCache(Redis)에 저장하는 Spring Session 설정이다.

```yaml
spring:
  session:
    store-type: redis
    timeout: 30m
  data:
    redis:
      host: ${REDIS_HOST}
      port: 6379
      ssl:
        enabled: true
```

```java
@Configuration
@EnableRedisHttpSession
public class SessionConfig {

    @Bean
    public CookieSerializer cookieSerializer() {
        DefaultCookieSerializer serializer = new DefaultCookieSerializer();
        serializer.setCookieName("SID");
        serializer.setUseSecureCookie(true);
        serializer.setSameSite("Lax");
        return serializer;
    }
}
```

RDS 페일오버 시 커넥션 풀이 오래된 주소를 붙잡지 않도록 AWS Advanced JDBC Wrapper의 failover 플러그인을 쓰는 설정이다.

```yaml
spring:
  datasource:
    driver-class-name: software.amazon.jdbc.Driver
    url: jdbc:aws-wrapper:postgresql://${DB_HOST}:5432/app?wrapperPlugins=failover,efm2&failoverTimeoutMs=30000
    username: ${DB_USER}
    password: ${DB_PASSWORD}
    hikari:
      maximum-pool-size: 20
      max-lifetime: 300000
      connection-timeout: 5000
```

## 실무에서 걸리는 지점

- RDS 페일오버는 자동이지만 애플리케이션 재연결은 자동이 아니다. JVM DNS 캐시(`networkaddress.cache.ttl`)와 풀의 `max-lifetime`을 짧게 두지 않으면 페일오버 뒤에도 수 분간 오류가 이어진다.
- Auto Scaling 확장 속도는 부팅 시간이 결정한다. 무거운 설치는 Golden AMI에 담고 User Data에는 환경별 동적 값만 남긴다.
- DR 전략은 페일오버 훈련으로 검증한다. 대상 리전에 AMI가 실제로 있는지, 리전마다 다른 AMI ID를 반영했는지 주기적으로 확인한다.
- DMS CDC는 소스 DB의 트랜잭션 로그에 의존한다. binlog나 logical replication이 꺼져 있으면 증분이 따라오지 않고, Snowball 배송 기간보다 로그 보존이 짧으면 CDC 시작점이 사라진다.
- Vault Lock은 되돌릴 수 없다. 잘못 지정한 보존 기간만큼 스토리지 비용이 확정되므로 유예 기간 동안 정책을 검증한다.

## 관련 글

- [ELB와 Auto Scaling](/notes/aws/elb-autoscaling/)
- [RDS·Aurora·DynamoDB](/notes/aws/rds-aurora-dynamodb/)
- [CI/CD와 개발자 도구 — CodePipeline·CDK·CloudFormation](/notes/aws/cicd-developer-tools/)
