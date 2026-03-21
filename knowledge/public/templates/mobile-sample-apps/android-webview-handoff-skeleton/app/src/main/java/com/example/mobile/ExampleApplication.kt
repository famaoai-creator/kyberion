package com.example.mobile

import android.app.Application
import com.example.mobile.handoff.AndroidWebViewStateReader
import com.example.mobile.session.SessionRepository
import dev.kyberion.handoff.DefaultKyberionHandoffExporter
import dev.kyberion.handoff.KyberionHandoffExporter
import dev.kyberion.handoff.KyberionHandoffStorage
import kotlinx.serialization.json.Json

class ExampleApplication : Application() {
    lateinit var sessionRepository: SessionRepository
        private set

    lateinit var handoffExporter: KyberionHandoffExporter
        private set

    override fun onCreate() {
        super.onCreate()

        sessionRepository = SessionRepository()
        handoffExporter = DefaultKyberionHandoffExporter(
            handoffEnabled = { BuildConfig.DEBUG && BuildConfig.KYBERION_HANDOFF_ENABLED },
            stateReader = AndroidWebViewStateReader(sessionRepository),
            storage = KyberionHandoffStorage(this, Json { prettyPrint = true })
        )
    }
}
