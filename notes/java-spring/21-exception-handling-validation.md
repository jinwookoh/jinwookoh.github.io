---
title: "예외 처리와 검증 — @ControllerAdvice·Bean Validation"
series: java-spring
part: "Web MVC"
order: 21
summary: "컨트롤러에서 try-catch와 if 검증을 걷어내고, 글로벌 핸들러와 검증 어노테이션으로 오류 응답을 한 형식으로 통일하는 방법"
tags: [Spring MVC, "@ControllerAdvice", Bean Validation, ProblemDetail, ConstraintValidator]
sources: [spring/2026-05-16-exception-handler-controlleradvice.md, spring/2026-05-16-bean-validation.md, spring/2026-05-16-custom-validator.md]
updated: 2026-08-29
---

서비스에서 "주문 없음" 예외가 올라오면, 별도 처리가 없을 때 Spring Boot는 500으로 응답한다. 정상적인 404 케이스인데도 클라이언트는 서버 장애로 인식한다. 컨트롤러마다 try-catch를 넣으면 변환 코드가 중복되고, DTO 검증을 if 문으로 처리하면 비즈니스 로직 앞에 방어 코드가 쌓인다. 예외를 상태 코드와 일관된 JSON으로 바꾸는 일과 입력 형식을 검사하는 일은 컨트롤러 바깥으로 빼야 한다.

## 핵심 개념

**@ExceptionHandler**는 특정 예외 타입이 발생했을 때 호출될 메서드를 선언한다. 컨트롤러 안에 두면 그 컨트롤러에서만, **@RestControllerAdvice**(`@ControllerAdvice` + `@ResponseBody`) 클래스에 두면 모든 컨트롤러에 적용된다. 여러 핸들러가 매칭되면 예외 계층에서 가장 가까운 타입이 선택되고, 컨트롤러 안의 핸들러가 글로벌 핸들러보다 우선한다. 마지막에 `Exception.class` 핸들러를 두어 예상하지 못한 예외를 500으로 정리한다.

비즈니스 예외는 `RuntimeException`을 상속한다. `@Transactional`의 기본 롤백 대상이 unchecked 예외이기 때문이다. 예외 클래스에 `@ResponseStatus`를 붙이면 핸들러 없이 상태 코드가 매핑되지만 응답 본문을 통제할 수 없다.

응답 본문은 자체 `ErrorResponse` DTO(분기용 `code` + 표시용 `message`) 또는 Spring Framework 6의 **ProblemDetail** 중 고른다. ProblemDetail은 RFC 9457(구 RFC 7807)의 `type`·`title`·`status`·`detail` 구조를 따르며, `spring.mvc.problemdetails.enabled=true`를 켜면 Spring MVC 내장 예외도 이 형식으로 변환된다.

**Bean Validation**은 Jakarta 표준 검증 명세이고 구현체는 Hibernate Validator다(`spring-boot-starter-validation` 필요). DTO 필드에 제약 어노테이션을 선언하고 컨트롤러 인자에 `@Valid`를 붙이면 바인딩 직후 검증이 실행되며, 실패 시 `MethodArgumentNotValidException`이 던져진다. 중첩 객체와 컬렉션 원소는 해당 필드에 `@Valid`를 붙여야 검증이 전파된다.

| 구분 | `@Valid` | `@Validated` |
|---|---|---|
| 출처 | Jakarta Bean Validation | Spring |
| groups 지정 | 불가 | 가능 |
| 클래스 레벨 선언 | 불가 | 가능 — AOP로 메서드 인자 검증 |
| 중첩 필드 전파 | 가능 | 불가 |

문자열 필수 검사에는 `@NotBlank`를 쓴다. `@NotNull`은 null만, `@NotEmpty`는 빈 값까지만 거르고 공백 문자열은 통과시킨다.

표준 어노테이션으로 표현되지 않는 규칙은 **커스텀 제약**으로 만든다. `@Constraint(validatedBy = ...)`가 붙은 어노테이션과 `ConstraintValidator<A, T>` 구현체 한 쌍이 필요하며, 어노테이션에는 `message`·`groups`·`payload` 세 속성이 있어야 한다. Validator를 `@Component`로 등록하면 빈을 주입받아 DB 조회도 가능하다. 두 필드 비교는 `@Target(TYPE)` 클래스 레벨 제약으로 처리한다.

## 코드

글로벌 핸들러. 검증 실패는 필드별 오류를 `properties`에 실어 반환한다.

```java
@RestControllerAdvice
public class GlobalExceptionHandler {

    private static final Logger log = LoggerFactory.getLogger(GlobalExceptionHandler.class);

    @ExceptionHandler(OrderNotFoundException.class)
    public ProblemDetail handleNotFound(OrderNotFoundException e) {
        ProblemDetail pd = ProblemDetail.forStatusAndDetail(HttpStatus.NOT_FOUND, e.getMessage());
        pd.setTitle("Order Not Found");
        pd.setType(URI.create("/errors/order-not-found"));
        pd.setProperty("code", "ORDER_NOT_FOUND");
        return pd;
    }

    @ExceptionHandler(MethodArgumentNotValidException.class)
    public ProblemDetail handleValidation(MethodArgumentNotValidException e) {
        Map<String, String> errors = new LinkedHashMap<>();
        for (FieldError fe : e.getBindingResult().getFieldErrors()) {
            errors.putIfAbsent(fe.getField(), fe.getDefaultMessage());
        }
        for (ObjectError oe : e.getBindingResult().getGlobalErrors()) {
            errors.putIfAbsent(oe.getObjectName(), oe.getDefaultMessage());
        }
        ProblemDetail pd = ProblemDetail.forStatusAndDetail(HttpStatus.BAD_REQUEST, "입력 검증 실패");
        pd.setProperty("code", "VALIDATION_FAILED");
        pd.setProperty("errors", errors);
        return pd;
    }

    @ExceptionHandler(Exception.class)
    public ProblemDetail handleUnknown(Exception e) {
        log.error("Unhandled exception", e);
        return ProblemDetail.forStatusAndDetail(HttpStatus.INTERNAL_SERVER_ERROR, "서버 오류");
    }
}
```

검증 대상 DTO와 컨트롤러. record를 쓰면 생성자 파라미터에 제약을 선언한다.

```java
public record UserSignupRequest(
        @NotBlank(message = "사용자 이름은 필수입니다")
        @Size(min = 2, max = 20, message = "사용자 이름은 2~20자")
        String username,

        @NotBlank @Email(message = "올바른 이메일 형식이 아닙니다")
        @UniqueEmail
        String email,

        @NotBlank @PhoneNumber
        String phoneNumber,

        @NotNull @Past(message = "생년월일은 과거 날짜여야 합니다")
        LocalDate birthDate,

        @Valid @NotNull
        AddressRequest address
) {}

@RestController
@RequestMapping("/api/users")
public class UserController {

    private final UserService userService;

    public UserController(UserService userService) {
        this.userService = userService;
    }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    public UserResponse signup(@RequestBody @Valid UserSignupRequest req) {
        return userService.signup(req);
    }
}
```

커스텀 제약 두 종류. null은 통과시키고 필수 여부는 `@NotBlank`에 맡긴다.

```java
@Target({ElementType.FIELD, ElementType.PARAMETER, ElementType.RECORD_COMPONENT})
@Retention(RetentionPolicy.RUNTIME)
@Constraint(validatedBy = PhoneNumberValidator.class)
public @interface PhoneNumber {
    String message() default "올바른 휴대폰 번호 형식이 아닙니다";
    Class<?>[] groups() default {};
    Class<? extends Payload>[] payload() default {};
}

public class PhoneNumberValidator implements ConstraintValidator<PhoneNumber, String> {
    private static final Pattern PATTERN = Pattern.compile("^01[016789]-\\d{3,4}-\\d{4}$");

    @Override
    public boolean isValid(String value, ConstraintValidatorContext ctx) {
        return value == null || PATTERN.matcher(value).matches();
    }
}

@Target({ElementType.FIELD, ElementType.PARAMETER, ElementType.RECORD_COMPONENT})
@Retention(RetentionPolicy.RUNTIME)
@Constraint(validatedBy = UniqueEmailValidator.class)
public @interface UniqueEmail {
    String message() default "이미 사용 중인 이메일입니다";
    Class<?>[] groups() default {};
    Class<? extends Payload>[] payload() default {};
}

@Component
public class UniqueEmailValidator implements ConstraintValidator<UniqueEmail, String> {
    private final UserRepository userRepository;

    public UniqueEmailValidator(UserRepository userRepository) {
        this.userRepository = userRepository;
    }

    @Override
    public boolean isValid(String email, ConstraintValidatorContext ctx) {
        if (email == null) return true;
        if (!userRepository.existsByEmail(email)) return true;
        ctx.disableDefaultConstraintViolation();
        ctx.buildConstraintViolationWithTemplate("이메일 " + email + " 은 이미 사용 중입니다")
           .addConstraintViolation();
        return false;
    }
}
```

## 실무에서 걸리는 지점

- **500 핸들러의 로그 누락.** 클라이언트에는 일반화된 메시지만 보내고 스택 트레이스는 서버 로그에 남긴다. 반대로 404·400을 ERROR 레벨로 남기면 로그 노이즈가 커진다.
- **Security 예외는 ControllerAdvice에 도달하지 않는다.** 인증·인가 실패는 Filter 단계에서 발생하므로 `AuthenticationEntryPoint`·`AccessDeniedHandler`로 형식을 맞춘다. `@ExceptionHandler(AccessDeniedException.class)`는 `@PreAuthorize` 실패에만 걸린다.
- **DB 조회 Validator의 경쟁 조건.** 검증 통과 후 저장 사이에 동일 이메일이 삽입될 수 있다. 최종 보장은 DB unique 제약과 `DataIntegrityViolationException` 처리에 두고, Validator는 조기 피드백 용도로 한정한다.
- **검증 예외 타입이 하나가 아니다.** `@Validated` 클래스의 메서드 인자 검증 실패는 `ConstraintViolationException`, `@RequestParam`·`@PathVariable` 제약 실패는 Spring 6.1부터 `HandlerMethodValidationException`으로 올라온다. `MethodArgumentNotValidException` 핸들러만 있으면 이들은 500으로 새어 나간다.
- **검증과 비즈니스 규칙의 경계.** 재고 부족 같은 규칙을 제약 어노테이션에 넣으면 트랜잭션 경계 밖에서 실행되고 테스트가 어려워진다. 서비스에서 도메인 예외로 던지고 핸들러가 상태 코드로 변환한다.

## 관련 글

- [예외 처리](/notes/java-spring/exception-handling/)
- [Controller와 요청 바인딩](/notes/java-spring/controller-request-binding/)
- [CORS와 Spring Security — OAuth2·JWT](/notes/java-spring/cors-security-oauth2-jwt/)
