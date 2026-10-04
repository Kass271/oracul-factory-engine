# syntax=docker/dockerfile:1
# build context = app root (needs api/openapi.yaml)
FROM eclipse-temurin:25-jdk AS build
WORKDIR /src
# Gradle wrapper + build files first: the dependency layer stays cached until they change.
COPY backend/gradlew backend/*.gradle.kts backend/gradle.propertie[s] ./backend/
COPY backend/gradle ./backend/gradle
COPY api ./api
WORKDIR /src/backend
RUN --mount=type=cache,target=/root/.gradle ./gradlew dependencies --no-daemon -q > /dev/null
# Production code only — a test change never rebuilds the image.
COPY backend/src/main ./src/main
RUN --mount=type=cache,target=/root/.gradle ./gradlew bootJar --no-daemon -q

FROM eclipse-temurin:25-jre
WORKDIR /app
COPY --from=build /src/backend/build/libs/*.jar app.jar
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "/app/app.jar"]
