package com.whale.chat;

import android.app.AlertDialog;
import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Bundle;
import android.text.InputType;
import android.view.ViewGroup;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;

public class MainActivity extends android.app.Activity {

    private WebView web;
    private ValueCallback<Uri[]> filePathCallback;
    private static final int REQ_FILE = 1001;
    private String url;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        SharedPreferences sp = getSharedPreferences("whale", Context.MODE_PRIVATE);
        url = sp.getString("url", "");

        FrameLayout root = new FrameLayout(this);
        web = new WebView(this);
        root.addView(web, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, String u) {
                if (u.startsWith("http://") || u.startsWith("https://")) return false;
                return true;
            }

            @Override
            public void onReceivedError(WebView v, int code, String desc, String failing) {
                if (failing != null && failing.startsWith("http")) askServer();
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams params) {
                filePathCallback = cb;
                try {
                    startActivityForResult(params.createIntent(), REQ_FILE);
                    return true;
                } catch (Exception e) {
                    filePathCallback = null;
                    return false;
                }
            }
        });

        if (url == null || url.isEmpty()) askServer();
        else web.loadUrl(url);
    }

    /** 输入电脑地址（房间服务）。 */
    private void askServer() {
        LinearLayout box = new LinearLayout(this);
        box.setPadding(40, 30, 40, 10);
        EditText input = new EditText(this);
        input.setHint("http://192.168.1.119:7501");
        input.setInputType(InputType.TYPE_TEXT_VARIATION_URI);
        input.setText(url == null || url.isEmpty() ? "http://192.168.1.119:7501" : url);
        box.addView(input);

        new AlertDialog.Builder(this)
                .setTitle("连接到电脑上的小助手")
                .setMessage("手机和电脑连同一个 Wi-Fi，填电脑的地址")
                .setView(box)
                .setPositiveButton("连接", (d, w) -> {
                    String u = input.getText().toString().trim();
                    if (u.isEmpty()) return;
                    if (!u.startsWith("http")) u = "http://" + u;
                    getSharedPreferences("whale", Context.MODE_PRIVATE).edit().putString("url", u).apply();
                    url = u;
                    web.loadUrl(u);
                })
                .setNegativeButton("取消", null)
                .show();
    }

    @Override
    protected void onActivityResult(int req, int res, android.content.Intent data) {
        if (req == REQ_FILE && filePathCallback != null) {
            filePathCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(res, data));
            filePathCallback = null;
            return;
        }
        super.onActivityResult(req, res, data);
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else askServer();
    }
}
