pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.PREFER_SETTINGS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "kiosk-erp-android"

// Application module (composition root: DI, navigation, manifest).
include(":app")

// Core layer — shared, feature-agnostic capabilities.
include(":core:common")
include(":core:database")
include(":core:network")
include(":core:security")
include(":core:data")

// Feature layer — one module per business domain (§5).
include(":feature:dashboard")
include(":feature:pos")
include(":feature:catalog")
include(":feature:inventory")
include(":feature:sync")
include(":feature:license")
include(":feature:settings")
