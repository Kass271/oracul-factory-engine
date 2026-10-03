plugins {
    java
    jacoco
    id("org.springframework.boot") version "{{BOOT_VERSION}}"
    id("io.spring.dependency-management") version "{{DEP_MGMT_VERSION}}"
    id("org.openapi.generator") version "{{OPENAPI_GEN_VERSION}}"
}

group = "com.oracul"
version = "0.1.0"

java {
    toolchain {
        languageVersion = JavaLanguageVersion.of(25)
    }
}

repositories {
    mavenCentral()
}

dependencies {
{{DEPENDENCIES}}
}

// ---- contract first: Spring interfaces + models are generated from api/openapi.yaml ----
val generatedDir = layout.buildDirectory.dir("generated/openapi")

openApiGenerate {
    generatorName.set("spring")
    inputSpec.set("$rootDir/../api/openapi.yaml")
    outputDir.set(generatedDir.get().asFile.path)
    apiPackage.set("com.oracul.app.api")
    modelPackage.set("com.oracul.app.api.model")
    configOptions.set(
        mapOf(
            "interfaceOnly" to "true",
            "useSpringBoot4" to "true",
            "useJakartaEe" to "true",
            "useTags" to "true",
            "skipDefaultInterface" to "true",
            "openApiNullable" to "false",
            "documentationProvider" to "none",
            "annotationLibrary" to "none",
            "useResponseEntity" to "true",
            "hideGenerationTimestamp" to "true",
        ),
    )
}

sourceSets {
    main {
        java.srcDir(generatedDir.map { it.dir("src/main/java") })
    }
}

tasks.compileJava { dependsOn(tasks.openApiGenerate) }

tasks.jar { enabled = false }

tasks.withType<Test> {
    useJUnitPlatform()
    finalizedBy(tasks.jacocoTestReport)
}

tasks.jacocoTestReport {
    dependsOn(tasks.test)
    reports {
        xml.required = true
        html.required = true
    }
    classDirectories.setFrom(
        files(classDirectories.files.map { fileTree(it) { exclude("com/oracul/app/api/**") } }),
    )
}
