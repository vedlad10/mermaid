// Mermaid landing page: contact links and the one "arrival" motion (figures count up, rows land).
(function () {
  "use strict";

  // Contact details live in one place so they're easy to change later (e.g. a domain email).
  var CONTACT = {
    email: "ladved829@gmail.com",
    emailSubject: "Mermaid demo",
    emailBody: "Hi Ved,\n\nI'd like a 20-minute Mermaid demo.\n\nPractice / company:\nBest days and times (with time zone):\n",
    whatsapp: "918355852904",
    whatsappText: "Hi, I'd like to see a Mermaid demo."
  };

  var mailto = "mailto:" + CONTACT.email +
    "?subject=" + encodeURIComponent(CONTACT.emailSubject) +
    "&body=" + encodeURIComponent(CONTACT.emailBody);
  var wa = "https://wa.me/" + CONTACT.whatsapp + "?text=" + encodeURIComponent(CONTACT.whatsappText);

  document.querySelectorAll('[data-contact="email"]').forEach(function (a) { a.setAttribute("href", mailto); });
  document.querySelectorAll('[data-contact="whatsapp"]').forEach(function (a) {
    a.setAttribute("href", wa); a.setAttribute("target", "_blank"); a.setAttribute("rel", "noopener");
  });

  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce || !("IntersectionObserver" in window)) return;

  document.documentElement.classList.add("js");
  var panels = document.querySelectorAll(".instrument, .money");
  panels.forEach(function (p) { p.classList.add("reveal"); });

  function countUp(el) {
    var target = Number(el.getAttribute("data-count"));
    var start = performance.now();
    var duration = 420;
    function frame(now) {
      var t = Math.min(1, (now - start) / duration);
      var eased = 1 - Math.pow(1 - t, 3);
      el.textContent = Math.round(target * eased).toLocaleString("en-US");
      if (t < 1) requestAnimationFrame(frame);
    }
    el.textContent = "0";
    requestAnimationFrame(frame);
  }

  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (!e.isIntersecting) return;
      e.target.classList.add("is-in");
      e.target.querySelectorAll("[data-count]").forEach(countUp);
      io.unobserve(e.target);
    });
  }, { threshold: 0.35 });

  panels.forEach(function (p) { io.observe(p); });
})();
