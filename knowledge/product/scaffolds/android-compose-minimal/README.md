# android-compose-minimal scaffold

E2E-05 Task 3 fixture. Placeholders `__APP_NAME__` / `__BUNDLE_ID__` are
replaced by the build-actuator `scaffold_app` op.

Note (documented deviation): the gradle-wrapper **jar** is intentionally not
committed (binary). `gradle/wrapper/gradle-wrapper.properties` is included, so
either run `gradle wrapper` once in the scaffolded app or rely on a system
`gradle` — the build-actuator falls back to `gradle` when `./gradlew` is
missing.
