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
        versionCode = 41
        versionName = "3.17.2"
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

    testOptions {
        unitTests.isIncludeAndroidResources = true
    }
}

dependencies {
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.robolectric:robolectric:4.11.1")
    testImplementation("org.mockito:mockito-core:5.7.0")
    testImplementation("androidx.test:core:1.5.0")
}
