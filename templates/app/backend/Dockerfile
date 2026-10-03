# build context = app root (needs api/openapi.yaml)
FROM eclipse-temurin:25-jdk AS build
WORKDIR /src
COPY api ./api
COPY backend ./backend
WORKDIR /src/backend
RUN ./gradlew bootJar --no-daemon -q

FROM eclipse-temurin:25-jre
WORKDIR /app
COPY --from=build /src/backend/build/libs/*.jar app.jar
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "/app/app.jar"]
