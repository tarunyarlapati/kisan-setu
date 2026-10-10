/* ============================================================
   Kisan Setu — Multilingual farmer assistant (chatbot widget)
   Wired to POST /api/assistant (server-side intent engine)
   ============================================================ */

(function () {
  "use strict";
  if (window.__KSCHAT__) return;
  window.__KSCHAT__ = true;

  var MESSAGES = {
    en: {
      title: "Kisan Setu Assistant",
      subtitle: "Ask about MSP, centres, bookings & payments",
      placeholder: "Type your question…",
      send: "Send",
      close: "Close",
      open: "Open assistant",
      bot: "Namaste! I'm the Kisan Setu assistant 🤝\nAsk me about MSP rates, which centre is least busy, or your booking & payment status.",
      error: "I couldn't reach the server. Please try again.",
      mic: "Speak your question",
      stopMic: "Stop recording",
      listening: "Listening…",
      tts: "Read replies aloud",
      ttsOff: "Turn sound off",
      voiceUnsupported: "Voice input isn't supported in this browser. Please type your question.",
      voiceNoSpeech: "I didn't catch that — please speak again.",
      voiceBlocked: "Microphone access was denied. Please allow the mic in your browser and try again.",
    },
    hi: {
      title: "किसान सेतु सहायक",
      subtitle: "MSP, केंद्र, बुकिंग व भुगतान के बारे में पूछें",
      placeholder: "अपना प्रश्न लिखें…",
      send: "भेजें",
      close: "बंद करें",
      open: "सहायक खोलें",
      bot: "नमस्ते! मैं किसान सेतु का सहायक हूँ 🤝\nMSP दरें, किस केंद्र में कम भीड़ है, या अपनी बुकिंग व भुगतान की स्थिति के बारे में पूछें।",
      error: "सर्वर से संपर्क नहीं हो पाया। कृपया पुनः प्रयास करें।",
      mic: "अपना प्रश्न बोलें",
      stopMic: "रिकॉर्डिंग बंद करें",
      listening: "सुन रहे हैं…",
      tts: "जवाब ज़ोर से सुनें",
      ttsOff: "आवाज़ बंद करें",
      voiceUnsupported: "इस ब्राउज़र में वॉइस इनपुट उपलब्ध नहीं है। कृपया अपना प्रश्न लिखें।",
      voiceNoSpeech: "मैंने सुना नहीं — कृपया फिर से बोलें।",
      voiceBlocked: "माइक्रोफ़ोन अनुमति अस्वीकृत हुई। कृपया ब्राउज़र में माइक की अनुमति दें और पुनः प्रयास करें।",
    },
    te: {
      title: "కిసాన్ సేతు సహాయకుడు",
      subtitle: "MSP, కేంద్రాలు, బుకింగ్‌లు & చెల్లింపుల గురించి అడగండి",
      placeholder: "మీ ప్రశ్న అడగండి…",
      send: "పంపండి",
      close: "మూసివేయండి",
      open: "సహాయకుడిని తెరవండి",
      bot: "నమస్తే! నేను కిసాన్ సేతు సహాయకుడిని 🤝\nMSP రేట్లు, ఏ కేంద్రం తక్కువ రద్దీగా ఉంది, లేదా మీ బుకింగ్, చెల్లింపు స్థితి గురించి అడగండి.",
      error: "సర్వర్‌ను చేరలేకపోయాను. దయచేసి మళ్ళీ ప్రయత్నించండి.",
      mic: "మీ ప్రశ్న మాట్లాడండి",
      stopMic: "రికార్డింగ్ ఆపండి",
      listening: "వింటున్నాం…",
      tts: "సమాధానాలు వినండి",
      ttsOff: "ధ్వని ఆపండి",
      voiceUnsupported: "ఈ బ్రౌజర్‌లో వాయిస్ ఇన్‌పుట్ అందుబాటులో లేదు. దయచేసి మీ ప్రశ్న టైప్ చేయండి.",
      voiceNoSpeech: "నేను వినలేకపోయాను — దయచేసి మళ్ళీ మాట్లాడండి.",
      voiceBlocked: "మైక్ యాక్సెస్ నిరాకరించబడింది. బ్రౌజర్‌లో మైక్ అనుమతి ఇచ్చి మళ్ళీ ప్రయత్నించండి.",
    },
  };

  function lang() {
    try {
      if (window.getLang && typeof window.getLang === "function") return window.getLang();
    } catch (e) {}
    return localStorage.getItem("ks_lang") || "en";
  }

  function txt(key) {
    var l = MESSAGES[lang()] || MESSAGES.en;
    return l[key] != null ? l[key] : MESSAGES.en[key];
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (m) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m];
    });
  }

  function init() {
    var css = document.createElement("style");
    css.textContent =
      "#ksChatBtn{position:fixed;right:20px;bottom:20px;z-index:150;width:58px;height:58px;border-radius:50%;border:0;cursor:pointer;background:linear-gradient(135deg,#16a34a 0%,#ea580c 100%);color:#fff;font-size:26px;box-shadow:0 8px 26px -6px rgba(16,24,40,.45);display:flex;align-items:center;justify-content:center;transition:transform .15s ease}" +
      "#ksChatBtn:hover{transform:scale(1.06)}" +
      "#ksChatBtn.on{transform:scale(0)" +
      "}#ksChatWrap{position:fixed;right:20px;bottom:20px;z-index:150;width:min(390px,calc(100vw - 32px));height:min(560px,calc(100vh - 90px));background:#fff;border:1px solid #e5e7eb;border-radius:16px;box-shadow:0 18px 50px -12px rgba(16,24,40,.35);display:flex;flex-direction:column;overflow:hidden;opacity:0;transform:translateY(16px) scale(.97);pointer-events:none;transition:opacity .18s ease,transform .18s ease}" +
      "#ksChatWrap.open{opacity:1;transform:none;pointer-events:auto}" +
      "#ksChatHead{background:linear-gradient(135deg,#15803d 0%,#c2410c 100%);color:#fff;padding:14px 16px;display:flex;align-items:center;gap:10px;flex-shrink:0}" +
      "#ksChatHead .ksChatAvatar{width:38px;height:38px;border-radius:50%;background:rgba(255,255,255,.2);display:flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0}" +
      "#ksChatHead .ksChatTitle{font-weight:800;font-size:.98rem;line-height:1.15}" +
      "#ksChatHead .ksChatSub{font-size:.74rem;opacity:.85;margin-top:2px}" +
      "#ksChatClose{margin-left:auto;border:0;background:rgba(255,255,255,.18);color:#fff;width:30px;height:30px;border-radius:50%;cursor:pointer;font-size:15px;display:flex;align-items:center;justify-content:center;flex-shrink:0}" +
      "#ksChatClose:hover{background:rgba(255,255,255,.32)}" +
      "#ksChatBody{flex:1;overflow-y:auto;background:#f9fafb;padding:14px;display:flex;flex-direction:column;gap:10px}" +
      ".ksBubble{max-width:82%;padding:10px 13px;border-radius:14px;font-size:.91rem;line-height:1.5;white-space:pre-wrap;word-break:break-word}" +
      ".ksBubble.bot{align-self:flex-start;background:#fff;border:1px solid #e5e7eb;border-bottom-left-radius:4px;box-shadow:0 1px 2px rgba(16,24,40,.06)}" +
      ".ksBubble.user{align-self:flex-end;background:#16a34a;color:#fff;border-bottom-right-radius:4px}" +
      ".ksBubble.bot a{color:#15803d;font-weight:600}" +
      "#ksChatInputRow{display:flex;gap:8px;padding:10px;border-top:1px solid #eef0f3;background:#fff;flex-shrink:0}" +
      "#ksChatInput{flex:1;border:1px solid #e5e7eb;border-radius:10px;padding:11px 12px;font:400 .93rem inherit;color:#111827;outline:none}" +
      "#ksChatInput:focus{border-color:#16a34a;box-shadow:0 0 0 3px rgba(22,163,74,.15)}" +
      "#ksChatSend{border:0;background:#16a34a;color:#fff;border-radius:10px;padding:0 16px;font-weight:700;cursor:pointer;font-size:.9rem}" +
      "#ksChatSend:hover{background:#15803d}" +
      "#ksChatSend:disabled{opacity:.55;cursor:not-allowed}" +
      ".ksTyping{align-self:flex-start;background:#fff;border:1px solid #e5e7eb;border-radius:14px;border-bottom-left-radius:4px;padding:11px 16px;display:flex;gap:4px;align-items:center}" +
      ".ksTyping i{width:7px;height:7px;border-radius:50%;background:#9ca3af;animation:ksBlink 1.2s infinite}" +
      ".ksTyping i:nth-child(2){animation-delay:.2s}.ksTyping i:nth-child(3){animation-delay:.4s}" +
      "@keyframes ksBlink{0%,80%,100%{opacity:.25}40%{opacity:1}}" +
      "#ksSugg{display:flex;flex-wrap:wrap;gap:6px;padding:8px 12px 2px;background:#fff;border-top:1px solid #eef0f3;flex-shrink:0}" +
      ".ksSug{font-size:.78rem;font-weight:600;color:#15803d;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:999px;padding:5px 10px;cursor:pointer}" +
      ".ksSug:hover{background:#dcfce7}" +
      "#ksHeadTts{border:0;background:rgba(255,255,255,.18);color:#fff;width:30px;height:30px;border-radius:50%;cursor:pointer;font-size:15px;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-right:6px}" +
      "#ksHeadTts:hover{background:rgba(255,255,255,.32)}" +
      "#ksHeadTts.on{background:#fff;color:#15803d}" +
      "#ksMicBtn{border:0;background:#e6f4ea;color:#15803d;border-radius:10px;padding:0 12px;font-size:1.05rem;cursor:pointer;flex-shrink:0}" +
      "#ksMicBtn:hover{background:#d1f2dc}" +
      "#ksMicBtn.on{background:#dc2626;color:#fff;animation:ksPulse 1.1s infinite}" +
      "#ksVoiceLang{border:1px solid #e5e7eb;border-radius:10px;padding:0 6px;font:700 0.8rem inherit;color:#111827;background:#fff;cursor:pointer;flex-shrink:0;height:40px;outline:none}" +
      "#ksVoiceLang:focus{border-color:#16a34a}" +
      "@keyframes ksPulse{0%,100%{box-shadow:0 0 0 0 rgba(220,38,38,.45)}50%{box-shadow:0 0 0 8px rgba(220,38,38,0)}}" +
      "@media(max-width:640px){#ksChatWrap{right:10px;left:10px;bottom:10px;width:auto}#ksChatBtn{right:14px;bottom:14px}}";
    document.head.appendChild(css);

    var btn = document.createElement("button");
    btn.type = "button";
    btn.id = "ksChatBtn";
    btn.setAttribute("aria-label", txt("open"));
    btn.title = txt("open");
    btn.innerHTML = "💬";

    var wrap = document.createElement("div");
    wrap.id = "ksChatWrap";
    wrap.setAttribute("role", "dialog");
    wrap.setAttribute("aria-label", txt("title"));

    wrap.innerHTML =
      '<div id="ksChatHead">' +
      '<span class="ksChatAvatar">🌾</span>' +
      '<div><div class="ksChatTitle">' + esc(txt("title")) + '</div><div class="ksChatSub">' + esc(txt("subtitle")) + "</div></div>" +
      '<button type="button" id="ksHeadTts" aria-label="' + esc(txt("tts")) + '" title="' + esc(txt("tts")) + '">🔊</button>' +
      '<button type="button" id="ksChatClose" aria-label="' + esc(txt("close")) + '">✕</button>' +
      "</div>" +
      '<div id="ksChatBody"></div>' +
      '<div id="ksSugg"></div>' +
      '<div id="ksChatInputRow">' +
      '<input id="ksChatInput" type="text" autocomplete="off" placeholder="' + esc(txt("placeholder")) + '" onkeydown="window.ksChatKey(event)">' +
      '<select id="ksVoiceLang" aria-label="Voice language"><option value="en">EN</option><option value="hi">हिं</option><option value="te">తెలు</option></select>' +
      '<button type="button" id="ksMicBtn" aria-label="' + esc(txt("mic")) + '" title="' + esc(txt("mic")) + '">🎤</button>' +
      '<button type="button" id="ksChatSend">' + esc(txt("send")) + "</button>" +
      "</div>";

    document.body.appendChild(btn);
    document.body.appendChild(wrap);

    var body = wrap.querySelector("#ksChatBody");
    var input = wrap.querySelector("#ksChatInput");
    var sendBtn = wrap.querySelector("#ksChatSend");
    var micBtn = wrap.querySelector("#ksMicBtn");
    var ttsBtn = wrap.querySelector("#ksHeadTts");
    var voiceSel = wrap.querySelector("#ksVoiceLang");
    var voiceOverride = null;

    var LANG_MAP = { en: "en-IN", hi: "hi-IN", te: "te-IN" };
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    var recog = null;
    var recWorking = false;
    var recTimer = null;
    var restartTimer = null;
    var micRetries = 0;
    var ttsOn = true;

    function pageSpeechLang() {
      return LANG_MAP[lang()] || "en-IN";
    }
    // Mic recognition language — follows the in-widget selector, then the page language
    function speechLang() {
      var l = voiceOverride || lang();
      return LANG_MAP[l] || "en-IN";
    }

    if (voiceSel) {
      voiceSel.value = lang();
      voiceSel.addEventListener("change", function () {
        voiceOverride = voiceSel.value;
        if (recog) { try { recog.lang = speechLang(); } catch (e) {} }
      });
    }

    function warmVoices() {
      try { if (window.speechSynthesis) window.speechSynthesis.getVoices(); } catch (e) {}
    }
    if (window.speechSynthesis) {
      warmVoices();
      window.speechSynthesis.addEventListener("voiceschanged", warmVoices);
    }

    function pickVoice(langCode) {
      var voices = window.speechSynthesis.getVoices() || [];
      var code = String(langCode || "").toLowerCase();
      var prefix = code.slice(0, 2);
      var kw = { te: "telugu", hi: "hindi", ta: "tamil", kn: "kannada", ml: "malayalam", bn: "bengali", gu: "gujarati", mr: "marathi", pa: "punjabi" };
      // 1) exact locale match
      var v = voices.find(function (x) { return (x.lang || "").toLowerCase() === code; });
      if (v) return v;
      // 2) matching language prefix + language keyword in the name (e.g. "Google తెలుగు")
      if (kw[prefix]) {
        v = voices.find(function (x) {
          return (x.lang || "").toLowerCase().indexOf(prefix) === 0 &&
                 String(x.name || "").toLowerCase().indexOf(kw[prefix]) !== -1;
        });
        if (v) return v;
      }
      // 3) any matching prefix, prefer Google voices for Indian languages
      v = voices.find(function (x) {
        return (x.lang || "").toLowerCase().indexOf(prefix) === 0 && /google|neural|online/i.test(x.name || "");
      });
      if (v) return v;
      v = voices.find(function (x) { return (x.lang || "").toLowerCase().indexOf(prefix) === 0; });
      if (v) return v;
      return null;
    }

    function initRecognition() {
      if (!SR) return false;
      try {
        recog = new SR();
        recog.continuous = false;
        recog.interimResults = true;
        recog.maxAlternatives = 3;
        recog.lang = speechLang();
        recog.onstart = function () {
          recWorking = true;
          micBtn.classList.add("on");
          micBtn.title = txt("stopMic");
          input.placeholder = txt("listening");
          if (recTimer) clearTimeout(recTimer);
          recTimer = setTimeout(autoStopMic, 12000);
        };
        recog.onresult = function (e) {
          var interim = "";
          var final = "";
          for (var i = e.resultIndex; i < e.results.length; i++) {
            if (!e.results[i] || !e.results[i][0]) continue;
            var t = e.results[i][0].transcript || "";
            if (e.results[i].isFinal) final += t;
            else interim += t;
          }
          if (final && final.trim()) {
            micRetries = 0;
            stopMic();
            sendText(final.trim());
          } else if (interim) {
            input.value = interim;
          }
        };
        recog.onerror = function (ev) {
          var err = ev && ev.error;
          if (err === "no-speech") {
            // Chrome often fails the first attempt on Indian locales — retry once
            if (micRetries < 2) {
              micRetries++;
              restartMic();
            } else {
              micRetries = 0;
              stopMic();
              msg("bot", txt("voiceNoSpeech"));
            }
          } else if (err === "not-allowed" || err === "service-not-allowed" || err === "audio-capture") {
            stopMic();
            msg("bot", txt("voiceBlocked"));
          } else {
            stopMic();
          }
        };
        recog.onend = function () {
          if (recWorking) stopMic();
        };
        return true;
      } catch (err) { return false; }
    }

    function autoStopMic() {
      if (recWorking) stopMic();
    }

    function restartMic() {
      if (restartTimer) clearTimeout(restartTimer);
      try { if (recog) recog.stop(); } catch (e) {}
      restartTimer = setTimeout(function () {
        restartTimer = null;
        if (!recog) return;
        try {
          recog.lang = speechLang();
          recog.start();
        } catch (err) { stopMic(); }
      }, 600);
    }

    function startMic() {
      if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
      if (!recog) { msg("bot", txt("voiceUnsupported")); return; }
      micRetries = 0;
      try {
        input.value = "";
        recog.lang = speechLang();
        recog.start();
      } catch (err) {
        if (recWorking) stopMic();
      }
    }

    function stopMic() {
      if (recTimer) { clearTimeout(recTimer); recTimer = null; }
      if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
      recWorking = false;
      micRetries = 0;
      if (recog) {
        try { recog.stop(); } catch (e) {}
        try { recog.abort(); } catch (e) {}
      }
      micBtn.classList.remove("on");
      micBtn.title = txt("mic");
      input.placeholder = txt("placeholder");
    }

    function sendText(text) {
      if (!text) return;
      input.value = text;
      send();
    }

    function speak(text, bcp) {
      if (!ttsOn || !window.speechSynthesis) return;
      try {
        var u = new SpeechSynthesisUtterance(String(text || "").replace(/[•*#]/g, " "));
        u.lang = bcp || pageSpeechLang();
        u.rate = 0.95;
        var v = pickVoice(u.lang);
        if (v) u.voice = v;
        window.speechSynthesis.cancel();
        window.speechSynthesis.speak(u);
      } catch (err) {}
    }

    function speakReply(text, replyLang) {
      var bcp = LANG_MAP[replyLang] || pageSpeechLang();
      window.ksLastReplyLang = replyLang;
      speak(text, bcp);
    }

    function toggleTts() {
      ttsOn = !ttsOn;
      ttsBtn.classList.toggle("on", ttsOn);
      ttsBtn.setAttribute("aria-label", txt(ttsOn ? "ttsOff" : "tts"));
      ttsBtn.title = txt(ttsOn ? "ttsOff" : "tts");
      if (window.speechSynthesis) { try { window.speechSynthesis.cancel(); } catch (err) {} }
      if (ttsOn) {
        var last = body.querySelector(".ksBubble.bot:last-child");
        if (last) speak(last.textContent, LANG_MAP[window.ksLastReplyLang] || pageSpeechLang());
      }
    }

    initRecognition();
    if (ttsOn) ttsBtn.classList.add("on");

    window.ksChatKey = function (e) {
      if (e && e.key === "Enter") send();
    };
    micBtn.addEventListener("click", function () {
      if (recWorking) stopMic(); else startMic();
    });
    ttsBtn.addEventListener("click", toggleTts);
    sendBtn.addEventListener("click", send);
    btn.addEventListener("click", function () {
      wrap.classList.add("open");
      btn.classList.add("on");
      btn.style.visibility = "hidden";
      if (/^\s*$/.test(window.ksChatBodyText || "")) {
        msg("bot", txt("bot")).classList.add("ksGreeting");
        if (ttsOn) speak(txt("bot"));
      }
      input.focus();
    });
    wrap.querySelector("#ksChatClose").addEventListener("click", function () {
      wrap.classList.remove("open");
      btn.classList.remove("on");
      btn.style.visibility = "";
    });

    function refresh() {
      btn.setAttribute("aria-label", txt("open"));
      btn.title = txt("open");
      wrap.setAttribute("aria-label", txt("title"));
      var titleEl = wrap.querySelector(".ksChatTitle");
      var subEl = wrap.querySelector(".ksChatSub");
      var closeEl = wrap.querySelector("#ksChatClose");
      var inputEl = wrap.querySelector("#ksChatInput");
      var sendEl = wrap.querySelector("#ksChatSend");
      if (titleEl) titleEl.textContent = txt("title");
      if (subEl) subEl.textContent = txt("subtitle");
      if (closeEl) closeEl.setAttribute("aria-label", txt("close"));
      if (inputEl) {
        inputEl.placeholder = recWorking ? txt("listening") : txt("placeholder");
      }
      if (sendEl) sendEl.textContent = txt("send");
      if (micBtn) {
        micBtn.setAttribute("aria-label", txt(recWorking ? "stopMic" : "mic"));
        micBtn.title = txt(recWorking ? "stopMic" : "mic");
      }
      if (ttsBtn) {
        ttsBtn.setAttribute("aria-label", txt(ttsOn ? "ttsOff" : "tts"));
        ttsBtn.title = txt(ttsOn ? "ttsOff" : "tts");
      }
      if (recog) { try { recog.lang = speechLang(); } catch (err) {} }
      if (voiceSel && !voiceOverride) voiceSel.value = lang();
      var g = body.querySelector(".ksGreeting");
      if (g) { g.textContent = txt("bot"); }
      renderSugg();
      var lastBot = body.querySelector(".ksBubble.bot:last-child");
      if (lastBot && ttsOn && !recWorking) speak(lastBot.textContent, LANG_MAP[window.ksLastReplyLang] || pageSpeechLang());
    }

    document.addEventListener("click", function (e) {
      var t = e.target && e.target.closest ? e.target.closest("[data-lang]") : null;
      if (t) refresh();
    });

    function msg(who, text, html) {
      var d = document.createElement("div");
      d.className = "ksBubble " + who;
      if (html) d.innerHTML = html;
      else d.textContent = text;
      body.appendChild(d);
      body.scrollTop = body.scrollHeight;
      window.ksChatBodyText = body.textContent;
      return d;
    }

    function send() {
      var text = input.value.trim();
      if (!text) return;
      msg("user", text);
      input.value = "";
      sendBtn.disabled = true;
      var t = document.createElement("div");
      t.className = "ksTyping";
      t.innerHTML = "<i></i><i></i><i></i>";
      body.appendChild(t);
      body.scrollTop = body.scrollHeight;

      window.api("/api/assistant", { method: "POST", body: { message: text, lang: lang() } })
        .then(function (res) {
          t.remove();
          var reply = res && res.reply ? res.reply : txt("error");
          msg("bot", reply);
          speakReply(reply, res && res.lang);
          renderSugg();
        })
        .catch(function () {
          t.remove();
          msg("bot", txt("error"));
        })
        .finally(function () {
          sendBtn.disabled = false;
          input.focus();
        });
    }

    var suggs = ["MSP rates", "which centre is least busy", "My booking / payment status"];

    function renderSugg() {
      var s = document.getElementById("ksSugg");
      if (!s) return;
      s.innerHTML = "";
      var items = [];
      if (lang() === "hi") items = ["MSP दरें", "किस केंद्र में कम भीड़ है?", "मेरा भुगतान कहाँ है?"];
      else if (lang() === "te") items = ["MSP రేట్లు", "ఏ కేంద్రం తక్కువ రద్దీ?", "చెల్లింపు స్థితి"];
      else items = suggs;
      items.forEach(function (q) {
        var b = document.createElement("button");
        b.type = "button";
        b.className = "ksSug";
        b.textContent = q;
        b.addEventListener("click", function () {
          input.value = q;
          send();
        });
        s.appendChild(b);
      });
    }
    renderSugg();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();