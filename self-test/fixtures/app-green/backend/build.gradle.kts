plugins { java; id("org.openapi.generator") version "7.25.0" }
openApiGenerate { inputSpec.set("$rootDir/../api/openapi.yaml") }
tasks.compileJava { dependsOn(tasks.openApiGenerate) }
