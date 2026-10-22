// threecast site — MIT License
// Progressive enhancement only: without this file every section, panel and command is visible
// and selectable. With it: copy buttons, collapsible panels, the index panel and scroll reveals.
(function () {
  "use strict";
  var root = document.documentElement;
  root.classList.add("js");
  window.threecastReady = true;

  var each = function (sel, fn, scope) { Array.prototype.forEach.call((scope || document).querySelectorAll(sel), fn); };
  var reduce = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  var live = document.getElementById("live");
  function say(text) {
    if (!live) return;
    live.textContent = "";
    setTimeout(function () { live.textContent = text; }, 40);
  }

  // ---- theme: Auto (follow the system), Light or Dark. The <head> script has already applied a
  // saved choice; this wires the buttons. Storage may throw, and then the choice lasts this visit.
  var THEME_KEY = "threecast-theme";
  var BG = { light: "#f7f7f7", dark: "#101010" };
  var themeBox = document.getElementById("theme");
  var switching = 0;
  function applyTheme(v) {
    // Colours change in one frame: with transitions on, the bar's background would fade while its text had already switched.
    root.classList.add("theme-switching");
    var n = ++switching;
    requestAnimationFrame(function () { requestAnimationFrame(function () { if (n === switching) root.classList.remove("theme-switching"); }); });
    if (v === "light" || v === "dark") root.setAttribute("data-theme", v);
    else { v = "auto"; root.removeAttribute("data-theme"); }
    each('meta[name="theme-color"]', function (m) {
      var media = /dark/.test(m.getAttribute("media") || "") ? "dark" : "light";
      m.setAttribute("content", BG[v === "auto" ? media : v]);
    });
    var cs = document.querySelector('meta[name="color-scheme"]');
    if (cs) cs.setAttribute("content", v === "auto" ? "light dark" : v);
    if (themeBox) each(".theme__b", function (b) {
      b.setAttribute("aria-pressed", b.getAttribute("data-theme-set") === v ? "true" : "false");
    }, themeBox);
    return v;
  }
  if (themeBox) {
    themeBox.hidden = false;
    applyTheme(root.getAttribute("data-theme"));
    themeBox.addEventListener("click", function (e) {
      var b = e.target.closest(".theme__b");
      if (!b) return;
      var v = applyTheme(b.getAttribute("data-theme-set"));
      try {
        if (v === "auto") localStorage.removeItem(THEME_KEY);
        else localStorage.setItem(THEME_KEY, v);
      } catch (err) { /* not saved; the page still switches */ }
      say(v === "auto" ? "Theme follows the system." : (v === "dark" ? "Dark" : "Light") + " theme.");
    });
    // Another tab changed it.
    window.addEventListener("storage", function (e) { if (e.key === THEME_KEY) applyTheme(e.newValue); });
  }

  // ---- top bar: solid once the page has scrolled, or while the index is open
  var top = document.getElementById("top");
  var toc = document.getElementById("toc");
  function onScroll() {
    if (top) top.classList.toggle("is-solid", window.scrollY > 24 || !!(toc && toc.classList.contains("is-open")));
  }
  onScroll();
  window.addEventListener("scroll", onScroll, { passive: true });

  // ---- copy buttons. Shell comments are left out: zsh, the macOS default, does not accept them pasted.
  function copyText(text, done) {
    function fallback() {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;";
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      done(ok);
    }
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(function () { done(true); }, fallback);
    else fallback();
  }
  function codeText(el) {
    var c = el.cloneNode(true);
    each(".c", function (n) { n.parentNode.removeChild(n); }, c);
    return c.textContent.split("\n").map(function (l) { return l.replace(/\s+$/, ""); }).join("\n").replace(/^\n+|\n+$/g, "");
  }
  each(".copy", function (btn) {
    btn.hidden = false;
    btn.addEventListener("click", function () {
      var text = btn.getAttribute("data-copy");
      if (text === null) {
        var code = btn.closest(".code") && btn.closest(".code").querySelector("pre code");
        text = code ? codeText(code) : "";
      }
      copyText(text, function (ok) {
        btn.textContent = ok ? "Copied" : "Select to copy";
        btn.classList.toggle("is-done", ok);
        say(ok ? "Copied to the clipboard." : "Copying did not work here. Select the text instead.");
        clearTimeout(btn._t);
        btn._t = setTimeout(function () { btn.textContent = "Copy"; btn.classList.remove("is-done"); }, 1800);
      });
    });
  });

  // ---- panels. Closed panels stay searchable with Ctrl-F where the browser supports hidden=until-found.
  var findable = "onbeforematch" in document.body;
  var panels = [];
  function setOpen(acc, open, animate) {
    acc._btn.setAttribute("aria-expanded", open ? "true" : "false");
    acc._sign.textContent = open ? "–" : "+";
    if (open) acc._body.removeAttribute("hidden");
    else acc._body.setAttribute("hidden", findable ? "until-found" : "");
    acc.classList.toggle("is-open", open);
    acc.classList.toggle("is-anim", open && !!animate && !reduce);
    syncAll();
  }
  each(".acc", function (acc) {
    var head = acc.querySelector(".acc__head");
    var body = acc.querySelector(".acc__body");
    if (!head || !body) return;
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "acc__head";
    btn.id = acc.id + "-b";
    btn.setAttribute("aria-controls", body.id);
    while (head.firstChild) btn.appendChild(head.firstChild);
    head.parentNode.replaceChild(btn, head);
    body.setAttribute("role", "region");
    body.setAttribute("aria-labelledby", btn.id);
    acc._btn = btn;
    acc._body = body;
    acc._sign = btn.querySelector(".acc__sign");
    panels.push(acc);
    btn.addEventListener("click", function () { setOpen(acc, btn.getAttribute("aria-expanded") !== "true", true); });
    body.addEventListener("beforematch", function () { setOpen(acc, true, false); });
  });
  var allButtons = [];
  function syncAll() {
    allButtons.forEach(function (b) {
      var items = b._list.querySelectorAll(".acc");
      var open = Array.prototype.every.call(items, function (a) { return a.classList.contains("is-open"); });
      b.textContent = open ? "Close all" : "Open all";
    });
  }
  each(".acc-all", function (b) {
    var list = document.getElementById(b.getAttribute("aria-controls"));
    if (!list) return;
    b._list = list;
    b.hidden = false;
    allButtons.push(b);
    b.addEventListener("click", function () {
      var open = b.textContent === "Open all";
      each(".acc", function (a) { if (a._btn) setOpen(a, open, false); }, list);
    });
  });
  panels.forEach(function (acc) { setOpen(acc, false, false); });

  // On load the panels above the target have just closed, so even a plain heading has moved:
  // jump to it again, at once (smooth scrolling is still off, see html.is-ready in style.css).
  function openForHash(initial) {
    var id = decodeURIComponent(location.hash.slice(1));
    var el = id && document.getElementById(id);
    if (!el) return;
    var acc = el.classList.contains("acc") ? el : el.closest(".acc");
    var opened = false;
    if (acc && acc._btn && !acc.classList.contains("is-open")) { setOpen(acc, true, false); opened = true; }
    if (opened || initial === true) el.scrollIntoView({ block: "start", behavior: "auto" });
  }
  window.addEventListener("hashchange", function () { openForHash(false); });
  openForHash(true);
  // After the first frame, or a moment later in a background tab, where frames do not run.
  var ready = function () { root.classList.add("is-ready"); };
  requestAnimationFrame(function () { requestAnimationFrame(ready); });
  setTimeout(ready, 400);

  // ---- index: a panel under the top bar on phones and tablets; the side column on wide screens
  var link = document.getElementById("top-index");
  if (toc && link) {
    var ib = document.createElement("button");
    ib.type = "button";
    ib.className = "top__index";
    ib.id = "top-index";
    ib.setAttribute("aria-controls", "toc");
    ib.setAttribute("aria-expanded", "false");
    ib.innerHTML = 'Index <span class="sign" aria-hidden="true">+</span>';
    link.parentNode.replaceChild(ib, link);
    var setToc = function (open, focus) {
      toc.classList.toggle("is-open", open);
      ib.setAttribute("aria-expanded", open ? "true" : "false");
      ib.querySelector(".sign").textContent = open ? "–" : "+";
      onScroll();
      if (open && focus) {
        var cur = toc.querySelector("[aria-current]") || toc.querySelector("a");
        if (cur) cur.focus();
      }
    };
    ib.addEventListener("click", function () { setToc(!toc.classList.contains("is-open"), true); });
    toc.addEventListener("click", function (e) { if (e.target.closest("a")) setToc(false); });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && toc.classList.contains("is-open")) { setToc(false); ib.focus(); }
    });
    document.addEventListener("click", function (e) {
      if (toc.classList.contains("is-open") && !toc.contains(e.target) && !ib.contains(e.target)) setToc(false);
    });
  }

  // ---- where am I: marks the current part in both indexes and names it in the top bar
  var links = {};
  each(".toc__list a", function (a) {
    var k = a.getAttribute("href").slice(1);
    (links[k] = links[k] || []).push(a);
  });
  var now = document.getElementById("top-now");
  function setCurrent(id) {
    Object.keys(links).forEach(function (k) {
      links[k].forEach(function (a) { if (k === id) a.setAttribute("aria-current", "location"); else a.removeAttribute("aria-current"); });
    });
    var a = id && links[id] && links[id][0];
    if (now) now.textContent = a ? a.querySelector(".toc__n").textContent + " " + a.querySelector(".toc__t").textContent : "";
  }
  if ("IntersectionObserver" in window) {
    var spy = new IntersectionObserver(function (es) {
      es.forEach(function (e) { if (e.isIntersecting) setCurrent(e.target.getAttribute("data-target") || ""); });
    }, { rootMargin: "-35% 0px -60% 0px" });
    each("main > section, main > .contents", function (s) { spy.observe(s); });
  }

  // ---- scroll reveal (the CSS shows everything when motion is reduced)
  if ("IntersectionObserver" in window) {
    var io = new IntersectionObserver(function (es) {
      es.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add("is-in"); io.unobserve(e.target); } });
    }, { rootMargin: "0px 0px -12% 0px" });
    each("[data-reveal]", function (el) { io.observe(el); });
  } else {
    each("[data-reveal]", function (el) { el.classList.add("is-in"); });
  }

  // ---- the lead, word by word. Screen readers get the sentence whole.
  var lead = document.getElementById("lead");
  if (lead && lead.children.length === 0 && !reduce && "IntersectionObserver" in window) {
    var text = lead.textContent;
    var sr = document.createElement("span");
    sr.className = "sr-only";
    sr.textContent = text;
    var shown = document.createElement("span");
    shown.setAttribute("aria-hidden", "true");
    var words = text.split(/\s+/).filter(Boolean);
    words.forEach(function (w, i) {
      var s = document.createElement("span");
      s.className = "w";
      s.textContent = w;
      shown.appendChild(s);
      if (i < words.length - 1) shown.appendChild(document.createTextNode(" "));
    });
    lead.textContent = "";
    lead.appendChild(sr);
    lead.appendChild(shown);
    var io2 = new IntersectionObserver(function (es) {
      es.forEach(function (e) {
        if (!e.isIntersecting) return;
        io2.disconnect();
        each(".w", function (s, i) { setTimeout(function () { s.classList.add("is-on"); }, i * 34); }, shown);
      });
    }, { rootMargin: "0px 0px -20% 0px" });
    io2.observe(lead);
  }

  // ---- code that scrolls sideways can be scrolled with the keyboard
  function markScrollers() {
    each(".code pre, .cmd__c", function (p) {
      if (p.scrollWidth > p.clientWidth + 1) p.setAttribute("tabindex", "0");
      else p.removeAttribute("tabindex");
    });
  }
  markScrollers();
  var rt;
  window.addEventListener("resize", function () { clearTimeout(rt); rt = setTimeout(markScrollers, 200); });
})();
