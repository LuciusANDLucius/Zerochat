const { withProjectBuildGradle } = require('expo/config-plugins');

/**
 * Expo Config Plugin to override compileSdkVersion and namespace for legacy BLE libraries
 * specifically fixes react-native-ble-advertiser on AGP 8+ / Gradle 9+
 */
function withAndroidCompileSdkVersion(config) {
  return withProjectBuildGradle(config, (config) => {
    if (config.modResults.language === 'groovy') {
      const buildGradle = config.modResults.contents;
      const subprojectsPatch = `
// [Expo Config Plugin] Fix compileSdkVersion & namespace for legacy libraries (react-native-ble-advertiser)
subprojects { subproject ->
    afterEvaluate {
        if (subproject.hasProperty("android")) {
            subproject.android {
                if (subproject.name == "react-native-ble-advertiser") {
                    namespace "com.vitorpamplona.bleavertiser"
                }
                try {
                    if (compileSdkVersion < 34) {
                        compileSdkVersion 34
                    }
                } catch (Exception e) {}
            }
        }
    }
}
`;
      if (!buildGradle.includes('subproject.name == "react-native-ble-advertiser"')) {
        config.modResults.contents = buildGradle + subprojectsPatch;
      }
    }
    return config;
  });
}

module.exports = withAndroidCompileSdkVersion;
