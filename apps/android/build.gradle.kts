// Root build file. Plugins are declared here (apply false) so every module can use the
// version-catalog aliases without repeating versions (§5 module graph).
plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.android.library) apply false
    alias(libs.plugins.kotlin.android) apply false
    alias(libs.plugins.kotlin.serialization) apply false
    alias(libs.plugins.ksp) apply false
}
