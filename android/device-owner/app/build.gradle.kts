plugins {
    id("com.android.application")
}

android {
    namespace = "com.otacon.kiosk"
    compileSdk = 34

    signingConfigs {
        create("release") {
            storeFile = file("../signing.jks")
            storePassword = "otacon123"
            keyAlias = "otacon"
            keyPassword = "otacon123"
        }
    }

    defaultConfig {
        applicationId = "com.otacon.kiosk"
        minSdk = 33
        targetSdk = 34
        versionCode = 5
        versionName = "1.4.0"
    }

    buildTypes {
        debug {
            signingConfig = signingConfigs.getByName("release")
        }
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    implementation("org.nanohttpd:nanohttpd:2.3.1")
}
