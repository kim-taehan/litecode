package com.litecode.speech

import android.content.Intent
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * 음성 입력 (#271) — 폰 자체 음성 인식(android.speech.SpeechRecognizer)을 JS 에 얇게 연다 (modules/litecode-speech/index.ts).
 * 폰은 폐쇄망이 아니라 기기의 인식 서비스(보통 구글)를 그대로 쓴다. 글을 합치는 규칙·오류 문구는 JS(src/app/voiceText.ts)가 정한다.
 *
 * 이벤트: onPartial{text} · onFinal{text} · onError{code}(SpeechRecognizer.ERROR_*) · onEnd — 한 번 듣기는 onFinal 또는 onError 뒤에 onEnd 로 끝난다.
 * SpeechRecognizer 는 메인 스레드에서만 만들고 부른다 → start·stop·cancel 은 Queues.MAIN.
 */
class SpeechModule : Module() {
  private var recognizer: SpeechRecognizer? = null

  override fun definition() = ModuleDefinition {
    Name("LitecodeSpeech")

    Events("onPartial", "onFinal", "onError", "onEnd")

    Function("available") {
      val context = appContext.reactContext ?: return@Function false
      SpeechRecognizer.isRecognitionAvailable(context)
    }

    // 이미 듣는 중이면 그것을 버리고 새로 듣는다
    AsyncFunction("start") { language: String ->
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      release()
      val created = SpeechRecognizer.createSpeechRecognizer(context)
      recognizer = created
      created.setRecognitionListener(Listener(created))
      created.startListening(
        Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
          .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
          .putExtra(RecognizerIntent.EXTRA_LANGUAGE, language)
          .putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
          .putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, context.packageName),
      )
    }.runOnQueue(Queues.MAIN)

    // 그만 듣고 들은 데까지 최종 결과를 낸다 (onFinal 또는 onError → onEnd)
    AsyncFunction("stop") {
      recognizer?.stopListening()
    }.runOnQueue(Queues.MAIN)

    // 결과 없이 버린다 — 이벤트가 더 오지 않는다
    AsyncFunction("cancel") {
      release()
    }.runOnQueue(Queues.MAIN)

    OnDestroy {
      release()
    }
  }

  private fun release() {
    recognizer?.let {
      it.cancel()
      it.destroy()
    }
    recognizer = null
  }

  private inner class Listener(private val owner: SpeechRecognizer) : RecognitionListener {
    // 버린(release) 인식기에서 늦게 온 콜백은 무시한다
    private fun current() = recognizer === owner

    private fun firstText(bundle: Bundle?): String =
      bundle?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull() ?: ""

    private fun finish() {
      release()
      sendEvent("onEnd", mapOf<String, Any>())
    }

    override fun onPartialResults(partialResults: Bundle?) {
      if (current()) sendEvent("onPartial", mapOf("text" to firstText(partialResults)))
    }

    override fun onResults(results: Bundle?) {
      if (!current()) return
      sendEvent("onFinal", mapOf("text" to firstText(results)))
      finish()
    }

    override fun onError(error: Int) {
      if (!current()) return
      sendEvent("onError", mapOf("code" to error))
      finish()
    }

    override fun onReadyForSpeech(params: Bundle?) {}
    override fun onBeginningOfSpeech() {}
    override fun onRmsChanged(rmsdB: Float) {}
    override fun onBufferReceived(buffer: ByteArray?) {}
    override fun onEndOfSpeech() {}
    override fun onEvent(eventType: Int, params: Bundle?) {}
  }
}
