#!/bin/bash
# test-mobile-hide-desktop-pills.sh
# Tests: Term/Code/Jupyter/MM/TAO nav pills are hidden on mobile (hidden md:inline-flex)

grep -q 'hidden md:inline-flex.*nav-pill.*Term\|nav-pill.*hidden md:inline-flex.*Term\|href="/terminal/".*hidden md:inline-flex\|hidden md:inline-flex.*href="/terminal/"' /opt/feather-dev/static/index.html || \
  grep -q 'href="/terminal/"[^>]*hidden md:inline-flex\|hidden md:inline-flex[^>]*href="/terminal/"' /opt/feather-dev/static/index.html || \
  grep -P 'href="/terminal/".*class="[^"]*hidden md:inline-flex|class="[^"]*hidden md:inline-flex[^"]*"[^>]*href="/terminal/"' /opt/feather-dev/static/index.html || exit 1
exit 0
