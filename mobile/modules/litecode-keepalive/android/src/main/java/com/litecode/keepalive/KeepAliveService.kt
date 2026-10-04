package com.litecode.keepalive

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig

/**
 * 연결 유지 — 상시 알림을 띄운 포그라운드 서비스 (이슈 #71).
 *
 * 하는 일은 둘이다:
 * 1. 포그라운드 서비스라 앱이 뒤로 가도 프로세스가 얼거나 죽지 않는다 → 데스크탑과의 연결(이벤트 스트림)이 살아 있다.
 * 2. HeadlessJsTaskService 라 "끝나지 않는 JS 작업" 하나가 돈다 → React Native 가 뒤에서도 JS 타이머를 돌린다
 *    (작업이 없으면 화면이 내려간 동안 setTimeout 이 멈춘다 — 끊겼을 때 다시 붙는 백오프·무응답 판정이 타이머다).
 *
 * 알림을 누르면 앱이 열린다. 서비스는 앱(JS)이 start/stop 으로만 올리고 내린다 — 죽었다가 혼자 다시 뜨지 않는다(START_NOT_STICKY):
 * 다시 뜬 프로세스에는 붙은 연결이 없다.
 */
class KeepAliveService : HeadlessJsTaskService() {
  private var taskStarted = false

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val notification = buildNotification(
      intent?.getStringExtra(EXTRA_TITLE) ?: "litecode",
      intent?.getStringExtra(EXTRA_TEXT) ?: "",
      intent?.getStringExtra(EXTRA_CHANNEL) ?: "litecode",
    )
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING)
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
    // 다시 start 가 오면(글이 바뀜) 알림만 고친다 — JS 작업은 하나만
    if (!taskStarted) {
      taskStarted = true
      super.onStartCommand(intent, flags, startId)
    }
    return START_NOT_STICKY
  }

  override fun getTaskConfig(intent: Intent?): HeadlessJsTaskConfig =
    HeadlessJsTaskConfig(TASK_NAME, Arguments.createMap(), 0, true)

  private fun buildNotification(title: String, text: String, channelName: String): Notification {
    val open = packageManager.getLaunchIntentForPackage(packageName)
    val contentIntent = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val manager = getSystemService(NotificationManager::class.java)
      // 조용한 채널 — 소리·진동 없이 떠 있기만 한다
      manager.createNotificationChannel(NotificationChannel(CHANNEL_ID, channelName, NotificationManager.IMPORTANCE_LOW))
      Notification.Builder(this, CHANNEL_ID)
    } else {
      @Suppress("DEPRECATION")
      Notification.Builder(this)
    }
    return builder
      .setContentTitle(title)
      .setContentText(text)
      .setSmallIcon(applicationInfo.icon)
      .setContentIntent(contentIntent)
      .setOngoing(true)
      .build()
  }

  companion object {
    const val TASK_NAME = "LitecodeKeepAlive"
    const val EXTRA_TITLE = "title"
    const val EXTRA_TEXT = "text"
    const val EXTRA_CHANNEL = "channel"
    private const val CHANNEL_ID = "keepalive"
    private const val NOTIFICATION_ID = 7100
  }
}
