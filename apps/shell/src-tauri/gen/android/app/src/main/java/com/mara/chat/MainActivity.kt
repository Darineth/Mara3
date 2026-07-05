package com.mara.chat

import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
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
      insets
    }
    ViewCompat.requestApplyInsets(content)
  }
}
