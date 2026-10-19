const fs = require('fs');
const path = require('path');

const targetFile = path.join(
  __dirname,
  '..',
  'node_modules',
  'react-native-ble-advertiser',
  'android',
  'build.gradle'
);

if (fs.existsSync(targetFile)) {
  const patchedContent = `apply plugin: 'com.android.library'

def safeExtGet(prop, fallback) {
    rootProject.ext.has(prop) ? rootProject.ext.get(prop) : fallback
}

android {
    namespace "com.vitorpamplona.bleavertiser"
    compileSdkVersion safeExtGet('compileSdkVersion', 34)
    buildToolsVersion safeExtGet('buildToolsVersion', "34.0.0")

    defaultConfig {
        minSdkVersion safeExtGet('minSdkVersion', 21)
        targetSdkVersion safeExtGet('targetSdkVersion', 34)
        versionCode 1
        versionName "1.0"
    }

    compileOptions {
        sourceCompatibility JavaVersion.VERSION_1_8
        targetCompatibility JavaVersion.VERSION_1_8
    }
}

dependencies {
    implementation 'com.facebook.react:react-native:+'
}
`;

  fs.writeFileSync(targetFile, patchedContent, 'utf8');
  console.log('✅ [postinstall] Patched react-native-ble-advertiser for Android 14 (SDK 34) & AGP 8+ namespace.');
} else {
  console.log('⚠️ [postinstall] react-native-ble-advertiser build.gradle not found (skipped patch).');
}
