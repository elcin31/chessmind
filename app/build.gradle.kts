plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "com.chessmind"
    compileSdk = 35
    ndkVersion = "27.2.12479018"

    defaultConfig {
        applicationId = "com.chessmind"
        minSdk = 29
        targetSdk = 35
        versionCode = 1
        versionName = "1.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        ndk.abiFilters += listOf("arm64-v8a", "x86_64")
    }

    buildFeatures.compose = true
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions.jvmTarget = "17"
    packaging.jniLibs.useLegacyPackaging = true
    sourceSets.getByName("main").jniLibs.srcDir(layout.buildDirectory.dir("stockfish/jniLibs"))
}

val stockfish by tasks.registering(Exec::class) {
    val bundle = rootProject.layout.projectDirectory.file("third_party/Stockfish-17.1.tar.gz")
    val script = rootProject.layout.projectDirectory.file("scripts/build-stockfish.sh")
    val destination = layout.buildDirectory.dir("stockfish/jniLibs")
    inputs.files(bundle, script)
    inputs.property("ndkVersion", android.ndkVersion)
    outputs.dir(destination)
    doFirst {
        commandLine(
            "bash", script.asFile.absolutePath,
            androidComponents.sdkComponents.ndkDirectory.get().asFile.absolutePath,
            destination.get().asFile.absolutePath
        )
    }
}
tasks.configureEach {
    if (name.startsWith("merge") && name.endsWith("JniLibFolders")) {
        dependsOn(stockfish)
    }
}

dependencies {
    implementation(platform("androidx.compose:compose-bom:2025.04.01"))
    implementation("androidx.activity:activity-compose:1.10.1")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.7")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test:runner:1.6.2")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
}
