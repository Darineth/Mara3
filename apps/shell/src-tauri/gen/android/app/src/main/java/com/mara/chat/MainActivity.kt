package com.mara.chat

import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.ScriptHandler
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import java.util.Locale

class MainActivity : TauriActivity() {
  // Handle for the document-start script carrying the current insets (see publishSafeArea).
  // Replaced — not stacked — every time the insets change.
  private var insetScript: ScriptHandler? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  // Edge-to-edge (above) gives the web layout its top safe-area inset, but it also stops the
  // soft keyboard from resizing the window, so the WebView can't see the keyboard and the
  // composer hides behind it. Watch the IME inset on the content container — NOT the WebView
  // itself, which would replace Chromium's own system-bar/cutout inset handling and zero out
  // the CSS safe-area insets — and shrink the WebView by the keyboard height. That shrinks
  // the page's viewport (dvh / visualViewport) so the bottom-anchored composer stays visible.
  // Insets are returned unconsumed so they still propagate to the WebView for the safe-area.
  override fun onWebViewCreate(webView: WebView) {
    val content = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { _, insets ->
      val ime = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
      // Shrink the WebView by the keyboard height via a bottom MARGIN (padding won't do it —
      // WebView keeps the full CSS viewport when only padded). A smaller view means a smaller
      // dvh / visualViewport, so the composer stays above the keyboard.
      val lp = webView.layoutParams as? ViewGroup.MarginLayoutParams
      if (lp != null && lp.bottomMargin != ime) {
        lp.bottomMargin = ime
        webView.layoutParams = lp
      }
      publishSafeArea(
        webView,
        insets.getInsets(
          WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
        ),
        ime,
      )
      insets
    }
    ViewCompat.requestApplyInsets(content)
  }

  // WebView's CSS `env(safe-area-inset-*)` only ever reports the display cutout — it knows
  // nothing about the status and navigation bars, which edge-to-edge is now drawing the page
  // underneath. So an always-visible (3-button) navigation bar sits on top of the composer.
  // Push the real bar insets into the page as --mara-android-inset-*; the web layout pads by
  // whichever is larger, those or env() (see @mara/ui styles.css).
  private fun publishSafeArea(webView: WebView, bars: Insets, ime: Int) {
    // Density can change under us (fold/unfold), so read it per dispatch. The viewport is
    // width=device-width, initial-scale=1, so one CSS px is one dp.
    val density = webView.resources.displayMetrics.density.takeIf { it > 0f } ?: 1f
    fun css(px: Int) = String.format(Locale.US, "%.2fpx", px / density)
    // The WebView is already shrunk by the keyboard, and the IME inset is measured from the
    // window bottom (so it subsumes the navigation bar) — don't pad for the bar twice.
    val bottom = (bars.bottom - ime).coerceAtLeast(0)
    val js = buildString {
      append("(function(){var v={")
      append("'--mara-android-inset-top':'").append(css(bars.top)).append("',")
      append("'--mara-android-inset-right':'").append(css(bars.right)).append("',")
      append("'--mara-android-inset-bottom':'").append(css(bottom)).append("',")
      append("'--mara-android-inset-left':'").append(css(bars.left)).append("'};")
      append("function a(){var e=document.documentElement;if(!e)return false;")
      append("for(var k in v)e.style.setProperty(k,v[k]);return true;}")
      append("if(!a())document.addEventListener('DOMContentLoaded',a);})();")
    }
    // Update the page that's loaded now...
    webView.evaluateJavascript(js, null)
    // ...and re-apply on every future document, since a reload drops the inline properties
    // with the old document and insets rarely change again once the app is up.
    if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
      insetScript?.remove()
      insetScript = WebViewCompat.addDocumentStartJavaScript(webView, js, setOf("*"))
    }
  }
}
