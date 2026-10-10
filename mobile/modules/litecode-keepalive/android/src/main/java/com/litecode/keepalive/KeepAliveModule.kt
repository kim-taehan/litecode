package com.litecode.keepalive

import android.content.Intent
import android.os.Build
import android.provider.Settings
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/** JS 가 연결 유지 서비스를 올리고 내리는 문 (modules/litecode-keepalive/index.ts) */
class KeepAliveModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("LitecodeKeepAlive")

    // 앱이 앞에 있을 때 부른다 — Android 12+ 는 뒤에서 포그라운드 서비스를 시작하지 못하게 막는다
    Function("start") { title: String, text: String, channel: String ->
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      val intent = Intent(context, KeepAliveService::class.java)
        .putExtra(KeepAliveService.EXTRA_TITLE, title)
        .putExtra(KeepAliveService.EXTRA_TEXT, text)
        .putExtra(KeepAliveService.EXTRA_CHANNEL, channel)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent) else context.startService(intent)
    }

    Function("stop") {
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      context.stopService(Intent(context, KeepAliveService::class.java))
    }

    // 짝짓기의 기기 키 재료 (이슈 #275) — API 26+ 에서 앱 서명 키·사용자·기기별로 고정, 재설치에도 같다. JS 가 해시해서 보낸다
    Function("androidId") {
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      Settings.Secure.getString(context.contentResolver, Settings.Secure.ANDROID_ID) ?: ""
    }
  }
}
