import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

fun quoteForGradle(value: String): String =
    "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"") + "\""

val repoRoot = layout.projectDirectory.dir("../..")
val generatedGoJniLibsDir = layout.buildDirectory.dir("generated/twoman-go-helper/jniLibs")

fun localProperties(): Properties {
    val properties = Properties()
    val file = rootProject.file("local.properties")
    if (file.exists()) {
        file.inputStream().use(properties::load)
    }
    return properties
}

fun androidSdkDir(): File {
    val properties = localProperties()
    val value = providers.environmentVariable("ANDROID_HOME").orNull
        ?: providers.environmentVariable("ANDROID_SDK_ROOT").orNull
        ?: properties.getProperty("sdk.dir")
        ?: throw GradleException("Set ANDROID_HOME, ANDROID_SDK_ROOT, or sdk.dir in local.properties")
    return file(value)
}

fun androidNdkDir(): File {
    val explicit = providers.environmentVariable("ANDROID_NDK_HOME").orNull
        ?: providers.environmentVariable("ANDROID_NDK_ROOT").orNull
        ?: localProperties().getProperty("ndk.dir")
    if (!explicit.isNullOrBlank()) {
        return file(explicit)
    }
    val ndkRoot = File(androidSdkDir(), "ndk")
    val latest = ndkRoot.listFiles { candidate -> candidate.isDirectory }
        ?.maxByOrNull { it.name }
    return latest ?: throw GradleException(
        "Android NDK is required to build the Go helper. Set ANDROID_NDK_HOME or install NDK under ${ndkRoot.absolutePath}",
    )
}

val buildTwomanGoHelper = tasks.register("buildTwomanGoHelper") {
    val helperSource = repoRoot.dir("helper-agent")
    inputs.dir(helperSource)
    outputs.dir(generatedGoJniLibsDir)

    doLast {
        val ndkDir = androidNdkDir()
        val clangDir = ndkDir.resolve("toolchains/llvm/prebuilt/linux-x86_64/bin")
        val targets = listOf(
            Triple("arm64-v8a", "arm64", "aarch64-linux-android24-clang"),
            Triple("x86_64", "amd64", "x86_64-linux-android24-clang"),
        )
        targets.forEach { (abi, goarch, clangName) ->
            val clang = clangDir.resolve(clangName)
            if (!clang.exists()) {
                throw GradleException("Missing Android NDK compiler: ${clang.absolutePath}")
            }
            val outFile = generatedGoJniLibsDir.get().asFile
                .resolve(abi)
                .resolve("libtwoman_helper.so")
            outFile.parentFile.mkdirs()
            exec {
                workingDir = helperSource.asFile
                environment("GOOS", "android")
                environment("GOARCH", goarch)
                environment("CGO_ENABLED", "1")
                environment("CC", clang.absolutePath)
                commandLine(
                    "go",
                    "build",
                    "-trimpath",
                    "-ldflags",
                    "-s -w",
                    "-o",
                    outFile.absolutePath,
                    ".",
                )
            }
        }
    }
}

val releaseStoreFile = providers.environmentVariable("TWOMAN_ANDROID_KEYSTORE_FILE").orNull
val releaseStorePassword = providers.environmentVariable("TWOMAN_ANDROID_KEYSTORE_PASSWORD").orNull
val releaseKeyAlias = providers.environmentVariable("TWOMAN_ANDROID_KEY_ALIAS").orNull
val releaseKeyPassword = providers.environmentVariable("TWOMAN_ANDROID_KEY_PASSWORD").orNull
val androidAppLabel = providers.environmentVariable("TWOMAN_ANDROID_APP_LABEL").orElse("Twoman").get()
val androidProxyTitle = providers.environmentVariable("TWOMAN_ANDROID_PROXY_TITLE").orElse("Twoman Proxy").get()
val androidVpnTitle = providers.environmentVariable("TWOMAN_ANDROID_VPN_TITLE").orElse("Twoman VPN").get()
val androidChannelName = providers.environmentVariable("TWOMAN_ANDROID_CHANNEL_NAME").orElse("Twoman Runtime").get()
val androidVpnSessionName = providers.environmentVariable("TWOMAN_ANDROID_VPN_SESSION_NAME").orElse("Twoman VPN").get()
val androidLogTag = providers.environmentVariable("TWOMAN_ANDROID_LOG_TAG").orElse("TwomanSvc").get()
val hasReleaseSigning =
    !releaseStoreFile.isNullOrBlank() &&
        !releaseStorePassword.isNullOrBlank() &&
        !releaseKeyAlias.isNullOrBlank() &&
        !releaseKeyPassword.isNullOrBlank()

android {
    namespace = "com.twoman.android"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.twoman.android"
        minSdk = 24
        targetSdk = 35
        versionCode = 19
        versionName = "1.0.6"
        buildConfigField("String", "RUNTIME_LOG_TAG", quoteForGradle(androidLogTag))
        buildConfigField("String", "VPN_SESSION_NAME", quoteForGradle(androidVpnSessionName))
        resValue("string", "runtime_app_name", quoteForGradle(androidAppLabel))
        resValue("string", "runtime_proxy_title", quoteForGradle(androidProxyTitle))
        resValue("string", "runtime_vpn_title", quoteForGradle(androidVpnTitle))
        resValue("string", "runtime_channel_name", quoteForGradle(androidChannelName))
    }

    sourceSets {
        getByName("main") {
            jniLibs.srcDir(generatedGoJniLibsDir)
        }
    }

    signingConfigs {
        if (hasReleaseSigning) {
            create("release") {
                storeFile = file(requireNotNull(releaseStoreFile))
                storePassword = requireNotNull(releaseStorePassword)
                keyAlias = requireNotNull(releaseKeyAlias)
                keyPassword = requireNotNull(releaseKeyPassword)
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            if (hasReleaseSigning) {
                signingConfig = signingConfigs.getByName("release")
            }
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }

    flavorDimensions += "abi"
    productFlavors {
        create("arm64") {
            dimension = "abi"
            ndk {
                abiFilters += "arm64-v8a"
            }
        }
        create("desktop") {
            dimension = "abi"
            ndk {
                abiFilters += "x86_64"
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        buildConfig = true
        viewBinding = true
    }
    packaging {
        jniLibs {
            useLegacyPackaging = true
            keepDebugSymbols += "**/libtwoman_helper.so"
        }
        resources {
            excludes += setOf(
                "META-INF/AL2.0",
                "META-INF/LGPL2.1",
            )
        }
    }
}

tasks.named("preBuild") {
    dependsOn(buildTwomanGoHelper)
}

dependencies {
    implementation(files("libs/tun2socks.aar"))
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.recyclerview:recyclerview:1.3.2")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20251224")
}
