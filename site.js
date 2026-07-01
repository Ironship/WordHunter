(() => {
  const slides = [...document.querySelectorAll(".slide")];
  const dots = [...document.querySelectorAll("[data-slide-dot]")];
  const prev = document.querySelector("[data-slide-prev]");
  const next = document.querySelector("[data-slide-next]");
  const frame = document.querySelector(".slideshow");
  if (!slides.length || !dots.length || !prev || !next || !frame) return;

  let active = 0;
  let timer = null;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function show(index) {
    active = (index + slides.length) % slides.length;
    slides.forEach((slide, i) => slide.classList.toggle("is-active", i === active));
    dots.forEach((dot, i) => {
      dot.classList.toggle("is-active", i === active);
      dot.setAttribute("aria-current", i === active ? "true" : "false");
    });
  }

  function stop() {
    if (timer) window.clearInterval(timer);
    timer = null;
  }

  function start() {
    if (reducedMotion || timer) return;
    timer = window.setInterval(() => show(active + 1), 5200);
  }

  prev.addEventListener("click", () => {
    stop();
    show(active - 1);
  });

  next.addEventListener("click", () => {
    stop();
    show(active + 1);
  });

  dots.forEach((dot, index) => {
    dot.addEventListener("click", () => {
      stop();
      show(index);
    });
  });

  frame.addEventListener("mouseenter", stop);
  frame.addEventListener("mouseleave", start);

  show(0);
  start();
})();
