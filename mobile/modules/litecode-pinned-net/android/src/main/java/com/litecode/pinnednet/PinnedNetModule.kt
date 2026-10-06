package com.litecode.pinnednet

import android.util.Base64
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import okhttp3.Call
import okhttp3.Callback
import okhttp3.ConnectionSpec
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import java.io.InterruptedIOException
import java.net.ConnectException
import java.net.InetSocketAddress
import java.net.Socket
import java.net.SocketTimeoutException
import java.security.MessageDigest
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLException
import javax.net.ssl.SSLPeerUnverifiedException
import javax.net.ssl.SSLSocket
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager
import kotlin.concurrent.thread

/**
 * 지문 고정 연결 (modules/litecode-pinned-net/index.ts · 모양은 src/core/net.ts 의 PinnedNetNative).
 * 데스크탑의 자체 서명 인증서를 **leaf 의 SPKI SHA-256 == 저장한 지문** 일 때만 믿는다. 체인·호스트 이름은 보지 않는다 — 신원은 지문이 정한다.
 * 지문 없이 요청을 보내는 길은 없다. probe 는 핸드셰이크 도중 인증서만 보고 끊는다(응용 데이터 0).
 * 오류 code 는 net.ts NATIVE_ERROR 와 같아야 한다: ERR_PIN_MISMATCH · ERR_TIMEOUT · ERR_REFUSED · ERR_UNREACHABLE.
 */
class PinnedNetModule : Module() {
  /** 지문마다 클라이언트 하나 — SSL 세션 캐시·연결 풀을 지문끼리 나눠 쓰지 않는다(재개된 세션은 trust manager 를 다시 부르지 않는다) */
  private val clients = ConcurrentHashMap<String, OkHttpClient>()
  private val streams = ConcurrentHashMap<String, Call>()

  override fun definition() = ModuleDefinition {
    Name("LitecodePinnedNet")
    Events("onStreamOpen", "onStreamData", "onStreamEnd")

    AsyncFunction("probe") { host: String, port: Int, timeoutMs: Int, promise: Promise ->
      thread(name = "litecode-probe", isDaemon = true) {
        try {
          promise.resolve(Pinning.probe(host, port, timeoutMs))
        } catch (error: Throwable) {
          reject(promise, error)
        }
      }
    }

    AsyncFunction("request") { url: String, method: String, headers: Map<String, String>, body: String?, timeoutMs: Int, pin: String, promise: Promise ->
      val call = try {
        client(pin).newBuilder().callTimeout(timeoutMs.toLong(), TimeUnit.MILLISECONDS).build().newCall(buildRequest(url, method, headers, body))
      } catch (error: Throwable) {
        reject(promise, error)
        return@AsyncFunction
      }
      call.enqueue(object : Callback {
        override fun onFailure(call: Call, e: IOException) = reject(promise, e)

        override fun onResponse(call: Call, response: Response) {
          try {
            response.use { promise.resolve(mapOf("status" to it.code, "body" to (it.body?.string() ?: ""))) }
          } catch (error: IOException) {
            reject(promise, error)
          }
        }
      })
    }

    // 결과는 이벤트로 — onStreamOpen {id, status} · onStreamData {id, text} · onStreamEnd {id, code?, message?}. closeStream 뒤에는 아무것도 안 보낸다
    Function("openStream") { id: String, url: String, headers: Map<String, String>, pin: String ->
      val call = client(pin).newCall(buildRequest(url, "GET", headers, null))
      streams[id] = call
      call.enqueue(object : Callback {
        override fun onFailure(call: Call, e: IOException) = end(id, call, e)

        override fun onResponse(call: Call, response: Response) {
          response.use {
            if (streams[id] !== call) return
            sendEvent("onStreamOpen", mapOf("id" to id, "status" to it.code))
            if (it.code != 200) return end(id, call, null)
            try {
              // charStream 은 UTF-8 글자가 조각 경계에서 잘려도 이어 붙인다. read 는 받은 만큼 바로 돌려준다
              val reader = it.body!!.charStream()
              val buffer = CharArray(8192)
              while (true) {
                val count = reader.read(buffer)
                if (count < 0) break
                if (streams[id] !== call) return
                sendEvent("onStreamData", mapOf("id" to id, "text" to String(buffer, 0, count)))
              }
              end(id, call, null)
            } catch (error: IOException) {
              end(id, call, error)
            }
          }
        }
      })
    }

    Function("closeStream") { id: String ->
      streams.remove(id)?.cancel()
    }

    OnDestroy {
      streams.values.forEach { it.cancel() }
      streams.clear()
    }
  }

  private fun client(pin: String): OkHttpClient = clients.getOrPut(pin) { Pinning.client(pin) }

  /** 스트림이 끝났다 — 내가 닫은 것(closeStream)이면 알리지 않는다 */
  private fun end(id: String, call: Call, error: Throwable?) {
    if (!streams.remove(id, call)) return
    val body = mutableMapOf<String, Any?>("id" to id)
    if (error != null) {
      body["code"] = Pinning.code(error)
      body["message"] = Pinning.message(error)
    }
    sendEvent("onStreamEnd", body)
  }

  private fun reject(promise: Promise, error: Throwable) = promise.reject(Pinning.code(error), Pinning.message(error), error)

  private fun buildRequest(url: String, method: String, headers: Map<String, String>, body: String?): Request {
    // 이 모듈은 https 만 — 평문은 JS 의 fetch 운반(이 컴퓨터 안)이 맡는다
    require(url.startsWith("https://")) { "pinned requests must be https" }
    val builder = Request.Builder().url(url)
    headers.forEach { (name, value) -> builder.header(name, value) }
    val type = headers.entries.firstOrNull { it.key.equals("content-type", ignoreCase = true) }?.value ?: "application/json"
    val requestBody = body?.toRequestBody(type.toMediaType()) ?: if (method == "POST") ByteArray(0).toRequestBody(null) else null
    return builder.method(method, requestBody).build()
  }
}

internal object Pinning {
  private const val MISMATCH = "certificate fingerprint mismatch: "

  /** leaf 인증서의 SubjectPublicKeyInfo(DER) SHA-256, base64url 패딩 없음 — 데스크탑·QR 의 fp 와 같은 모양 */
  fun fingerprint(certificate: X509Certificate): String =
    Base64.encodeToString(MessageDigest.getInstance("SHA-256").digest(certificate.publicKey.encoded), Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)

  class PinMismatch(actual: String) : CertificateException(MISMATCH + actual)

  private class PinTrustManager(private val pin: String) : X509TrustManager {
    override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
      val leaf = chain?.firstOrNull() ?: throw CertificateException("no server certificate")
      val actual = fingerprint(leaf)
      if (!MessageDigest.isEqual(actual.toByteArray(), pin.toByteArray())) throw PinMismatch(actual)
    }

    override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) = throw CertificateException("not a server")

    override fun getAcceptedIssuers(): Array<X509Certificate> = arrayOf()
  }

  fun client(pin: String): OkHttpClient {
    val trust = PinTrustManager(pin)
    val context = SSLContext.getInstance("TLS").apply { init(null, arrayOf<TrustManager>(trust), null) }
    return OkHttpClient.Builder()
      .sslSocketFactory(context.socketFactory, trust)
      // 자체 서명 인증서에 IP 로 붙는다 — 이름 검증은 뜻이 없고, 신원은 위의 지문 대조가 정한다
      .hostnameVerifier { _, _ -> true }
      // 평문(CLEARTEXT)을 빼 둔다 — http:// 로는 이 클라이언트가 아예 나가지 않는다
      .connectionSpecs(listOf(ConnectionSpec.MODERN_TLS))
      .connectTimeout(10, TimeUnit.SECONDS)
      // 스트림은 오래 열려 있다 — 조용함은 JS 가 30초로 본다(REMOTE_SILENCE_TIMEOUT_MS). 요청은 callTimeout 으로 끊는다
      .readTimeout(0, TimeUnit.MILLISECONDS)
      // 한 번 더 — TLS 를 맺은 뒤 HTTP 를 쓰기 **전에** 이 연결의 leaf 지문을 대조한다. 재개된 세션·플랫폼이 trust manager 를 건너뛰는
      // 경로가 있어도 여기서 막힌다 (데스크탑 계약: "연결을 맺은 뒤 지문을 비교하고 통과한 뒤에만 HTTP 를 보낸다")
      .addNetworkInterceptor { chain ->
        val leaf = chain.connection()?.handshake()?.peerCertificates?.firstOrNull() as? X509Certificate
          ?: throw SSLPeerUnverifiedException("no server certificate")
        val actual = fingerprint(leaf)
        if (!MessageDigest.isEqual(actual.toByteArray(), pin.toByteArray())) throw SSLPeerUnverifiedException(MISMATCH + actual)
        chain.proceed(chain.request())
      }
      .build()
  }

  /** 핸드셰이크 도중 서버 인증서의 지문만 보고 끊는다 — 응용 데이터는 한 바이트도 오가지 않는다 */
  fun probe(host: String, port: Int, timeoutMs: Int): String {
    var seen: String? = null
    val recorder = object : X509TrustManager {
      override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
        seen = chain?.firstOrNull()?.let { fingerprint(it) }
        throw CertificateException("probe only")
      }

      override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) = throw CertificateException("not a server")

      override fun getAcceptedIssuers(): Array<X509Certificate> = arrayOf()
    }
    val context = SSLContext.getInstance("TLS").apply { init(null, arrayOf<TrustManager>(recorder), null) }
    Socket().use { raw ->
      raw.connect(InetSocketAddress(host, port), timeoutMs)
      raw.soTimeout = timeoutMs
      (context.socketFactory.createSocket(raw, host, port, true) as SSLSocket).use { tls ->
        try {
          tls.startHandshake()
        } catch (error: SSLException) {
          if (seen == null) throw error
        }
      }
    }
    return seen ?: throw SSLException("no server certificate")
  }

  private fun chain(error: Throwable): Sequence<Throwable> = generateSequence(error) { it.cause }.take(8)

  fun code(error: Throwable): String {
    val causes = chain(error).toList()
    return when {
      causes.any { it is PinMismatch || (it.message ?: "").contains(MISMATCH) } -> "ERR_PIN_MISMATCH"
      causes.any { it is SocketTimeoutException || (it is InterruptedIOException && it.message == "timeout") } -> "ERR_TIMEOUT"
      causes.any { it is ConnectException && (it.message ?: "").contains("refused", ignoreCase = true) } -> "ERR_REFUSED"
      causes.any { (it.message ?: "").contains("ETIMEDOUT") } -> "ERR_TIMEOUT"
      // NoRouteToHost(EHOSTUNREACH)·주소 틀림·그 밖
      else -> "ERR_UNREACHABLE"
    }
  }

  /** 지문이 달랐으면 실제 지문을 싣는다 (JS 가 꺼낸다) */
  fun message(error: Throwable): String {
    val mismatch = chain(error).mapNotNull { it.message }.firstOrNull { it.contains(MISMATCH) }
    return mismatch?.substring(mismatch.indexOf(MISMATCH)) ?: (error.message ?: error.javaClass.simpleName)
  }
}
