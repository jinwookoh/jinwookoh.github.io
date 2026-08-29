---
title: "배포 — Docker·Buildpack"
series: java-spring
part: "운영·통합"
order: 37
summary: "Spring Boot 앱을 컨테이너 이미지로 만드는 두 경로(Buildpack·Dockerfile)와 Compose·Kubernetes 운영 시 확인할 지점을 정리한다."
tags: [Docker, Buildpack, Layered JAR, Docker Compose, Kubernetes]
sources: [2026-05-02-spring-containers-deployment.md, 2026-05-02-spring-cloud-gateway-build.md]
updated: 2026-08-29
---

JAR 파일을 서버에 복사해 `java -jar`로 띄우는 방식은 실행 환경을 서버마다 손으로 맞춰야 한다. JDK 버전, OS 라이브러리, 환경 변수, 포트 설정이 한 곳이라도 다르면 로컬에서 통과한 코드가 서버에서 실패하고, 원인을 찾으려면 두 환경의 차이를 하나씩 대조해야 한다. 인스턴스를 여러 개 띄우거나 새 버전으로 교체할 때도 같은 작업이 반복된다. 컨테이너는 애플리케이션과 실행 환경을 하나의 불변 이미지로 묶어 이 차이를 없애고, Spring Boot는 빌드 플러그인만으로 그 이미지를 만드는 경로를 제공한다.

## 핵심 개념

**이미지와 컨테이너.** 이미지는 OS 라이브러리·JRE·애플리케이션·설정을 레이어로 쌓은 읽기 전용 템플릿이고, 컨테이너는 그 이미지 위에 쓰기 가능한 레이어를 얹어 실행한 인스턴스다. 하나의 이미지로 여러 컨테이너를 동시에 띄울 수 있으며, 컨테이너 내부에 기록한 데이터는 컨테이너가 삭제되면 함께 사라진다. 영속화가 필요한 데이터는 Volume이나 외부 저장소에 둔다.

**Layered JAR.** Spring Boot 실행 가능 JAR은 의존성 JAR을 중첩해 담는 fat JAR이라 통째로 이미지에 넣으면 코드 한 줄이 바뀌어도 수십 MB짜리 레이어가 다시 만들어진다. 이를 피하기 위해 Boot는 JAR을 `dependencies`, `spring-boot-loader`, `snapshot-dependencies`, `application` 네 레이어로 나누는 구조를 기본으로 제공한다. 변경 빈도가 낮은 순서로 COPY하면 Docker 빌드 캐시가 앞 레이어를 재사용한다. 레이어 추출은 Boot 3.3부터 `-Djarmode=tools`가 기본이고 기존 `layertools`는 제거 예정이다.

**Buildpack.** Cloud Native Buildpacks는 Dockerfile 없이 소스에서 OCI 이미지를 만드는 표준이며, Spring Boot Maven/Gradle 플러그인은 Paketo Buildpacks를 내장한다. `spring-boot:build-image` 또는 `bootBuildImage`를 실행하면 플러그인이 JAR을 패키징하고, 빌드팩이 자바 버전을 감지해 JRE 베이스 이미지를 고른 뒤 Layered JAR을 레이어로 배치하고 로컬 Docker 데몬에 이미지를 등록한다. JVM 메모리 계산기, 빌드 메타데이터 라벨, 비 root 실행이 기본으로 들어간다.

| 항목 | Buildpack | Dockerfile |
|:---|:---|:---|
| 정의 파일 | 불필요 | 직접 작성 |
| 베이스 이미지·보안 패치 | 빌더 갱신으로 일괄 | 이미지마다 수동 |
| 레이어 최적화 | 자동 | 직접 설계 |
| 커스터마이징 | 환경 변수 범위 | 제한 없음 |
| 빌드 속도 | 첫 빌드 느림 | 캐시 활용 시 빠름 |

판단 기준은 단순하다. OS 패키지 추가나 베이스 이미지 교체 같은 요구가 없으면 Buildpack을 쓰고, 그 요구가 생기면 Dockerfile로 내려간다.

**Compose와 Kubernetes.** Compose는 단일 호스트의 여러 컨테이너를 하나의 YAML로 정의하고, Kubernetes는 여러 호스트에 걸쳐 복제·롤링 업데이트·자동 복구를 담당한다. Kubernetes에서 실제로 다루는 오브젝트는 Pod, Deployment, Service, ConfigMap·Secret 네 가지다. Actuator의 `/actuator/health/liveness`와 `/actuator/health/readiness`는 Kubernetes Probe와 맞물리며, Kubernetes 환경을 감지하면 자동 활성화된다.

## 코드

Maven 플러그인에 이미지 이름과 JVM 버전을 지정한다. 실행은 `./mvnw spring-boot:build-image`, Gradle은 `./gradlew bootBuildImage`다.

```xml
<plugin>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-maven-plugin</artifactId>
    <configuration>
        <image>
            <name>acme/${project.artifactId}:${project.version}</name>
            <env>
                <BP_JVM_VERSION>21</BP_JVM_VERSION>
            </env>
            <publish>false</publish>
        </image>
    </configuration>
</plugin>
```

Dockerfile이 필요한 경우의 멀티 스테이지 빌드. `jarmode=tools`로 레이어를 추출하고 변경 빈도 순으로 복사한다.

```dockerfile
FROM eclipse-temurin:21-jdk-alpine AS builder
WORKDIR /app
COPY .mvn/ .mvn
COPY mvnw pom.xml ./
RUN ./mvnw dependency:go-offline
COPY src ./src
RUN ./mvnw clean package -DskipTests \
    && java -Djarmode=tools -jar target/*.jar extract --layers --destination target/extracted

FROM eclipse-temurin:21-jre-alpine
WORKDIR /app
RUN addgroup -S spring && adduser -S spring -G spring
USER spring:spring
COPY --from=builder /app/target/extracted/dependencies/ ./
COPY --from=builder /app/target/extracted/spring-boot-loader/ ./
COPY --from=builder /app/target/extracted/snapshot-dependencies/ ./
COPY --from=builder /app/target/extracted/application/ ./
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD wget -q -O /dev/null http://localhost:8080/actuator/health || exit 1
EXPOSE 8080
ENTRYPOINT ["java", "org.springframework.boot.loader.launch.JarLauncher"]
```

Compose로 DB와 앱을 함께 띄운다. 앱은 DB의 healthcheck 통과 후 시작하고, 설정은 환경 변수로 주입한다.

```yaml
services:
  mysql:
    image: mysql:8.4
    environment:
      MYSQL_ROOT_PASSWORD: ${MYSQL_ROOT_PASSWORD}
      MYSQL_DATABASE: restdb
    volumes:
      - mysql_data:/var/lib/mysql
    healthcheck:
      test: ["CMD", "mysqladmin", "ping", "-h", "localhost"]
      interval: 10s
      timeout: 5s
      retries: 5

  app:
    image: acme/myapp:0.0.1-SNAPSHOT
    depends_on:
      mysql:
        condition: service_healthy
    ports:
      - "8080:8080"
    environment:
      SPRING_DATASOURCE_URL: jdbc:mysql://mysql:3306/restdb
      SPRING_PROFILES_ACTIVE: ${SPRING_PROFILES_ACTIVE:-dev}

volumes:
  mysql_data:
```

## 실무에서 걸리는 지점

- **컨테이너 안의 `localhost`는 자기 자신이다.** 같은 네트워크의 다른 컨테이너는 서비스 이름으로 접근해야 한다. `jdbc:mysql://localhost:3306`을 이미지에 넣고 Compose로 띄우면 연결이 거부된다.
- **`depends_on`은 시작 순서만 보장한다.** DB 프로세스가 떴어도 연결을 받을 준비는 안 됐을 수 있으므로 `condition: service_healthy`와 healthcheck를 함께 둔다. `docker compose stop`은 중지만, `down`은 삭제, `down -v`는 볼륨까지 삭제라는 차이도 실수가 잦다.
- **Buildpack 빌드는 Docker 데몬이 떠 있어야 한다.** CI 러너에 Docker가 없으면 `build-image`가 실패하고, 첫 빌드는 빌더 이미지 다운로드로 수 분이 걸린다. Apple Silicon에서 amd64로 배포한다면 `imagePlatform`을 명시한다.
- **Probe의 `initialDelaySeconds`가 짧으면 기동 중인 Pod가 재시작된다.** liveness 실패는 재시작, readiness 실패는 트래픽 차단이므로 JVM 기동 시간에 맞춰 liveness를 더 길게 잡거나 `startupProbe`를 둔다.
- **비밀 값을 Dockerfile `ENV`나 ConfigMap에 넣지 않는다.** 둘 다 암호화되지 않는다. 런타임 환경 변수나 Secret으로 주입하고, Pod에는 `requests`·`limits`를 지정해 한 컨테이너의 자원 독점을 막는다.

## 관련 글

- /notes/java-spring/build-and-project-setup/
- /notes/java-spring/actuator-micrometer/
- /notes/java-spring/msa-spring-kafka-gateway/
