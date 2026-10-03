plugins {
    // downloads the Java 25 toolchain automatically when it is not installed locally
    id("org.gradle.toolchains.foojay-resolver-convention") version "{{FOOJAY_VERSION}}"
}
rootProject.name = "backend"
