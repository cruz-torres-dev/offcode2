// Preserve collection anchors and campaign parameters on previously shared links.
location.replace(
  new URL("index.html" + location.search + location.hash, location.href).href,
);
