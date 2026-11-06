/*
 * FirstPromoter tracking for Shopify.
 *
 * 1. Loads FirstPromoter's fpr.js and records the click ("fpr('click')").
 * 2. Copies the visitor id (cookie _fprom_tid) into the cart attribute fp_tid.
 *    Shopify passes cart attributes to the order, which is how the app can
 *    attribute a sale to the right affiliate after checkout.
 */
(function () {
  'use strict';

  var config = window.__FPR_CONFIG;
  if (!config || !config.cid) return;

  var started = false;
  var CONSENT_EVENT = 'visitorConsentCollected';

  function privacyApi() {
    var privacy = window.Shopify && window.Shopify.customerPrivacy;
    return privacy && typeof privacy.marketingAllowed === 'function' ? privacy : null;
  }

  function marketingAllowed(privacy) {
    try {
      return privacy.marketingAllowed();
    } catch (e) {
      return false;
    }
  }

  // The consent API is often loaded after this script. Load it ourselves and
  // decide only once it is there; never assume consent while it is loading.
  function withPrivacyApi(callback) {
    var privacy = privacyApi();
    if (privacy) return callback(privacy);
    var shopify = window.Shopify;
    if (!shopify || typeof shopify.loadFeatures !== 'function') return callback(null);
    shopify.loadFeatures([{ name: 'consent-tracking-api', version: '0.1' }], function (error) {
      callback(error ? null : privacyApi());
    });
  }

  function readTid() {
    var m = document.cookie.match(/(?:^|; )_fprom_tid=([^;]+)/);
    if (!m) return null;
    try {
      return decodeURIComponent(m[1]);
    } catch (e) {
      return m[1];
    }
  }

  var syncedTid = null; // tid known to be stored in the cart already

  function syncCart(tid) {
    return fetch('/cart.js', { credentials: 'same-origin' })
      .then(function (r) {
        return r.json();
      })
      .then(function (cart) {
        var attrs = (cart && cart.attributes) || {};
        if (attrs.fp_tid === tid) {
          syncedTid = tid;
          return null;
        }
        return fetch('/cart/update.js', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ attributes: { fp_tid: tid } })
        }).then(function (r) {
          if (r && r.ok) syncedTid = tid;
        });
      })
      .catch(function () {
        /* tracking must never break the storefront */
      });
  }

  // Resolves after the sync, but never keeps the buyer waiting for long.
  function syncWithTimeout(tid, ms) {
    return Promise.race([
      syncCart(tid),
      new Promise(function (resolve) {
        setTimeout(resolve, ms);
      })
    ]);
  }

  // "Buy it now" skips the cart, so the cart attribute would be lost. For the
  // theme's own "Buy it now" button we do the same steps through the cart:
  // add the product, store fp_tid on the cart, then open the checkout.
  var buyNowBypass = false;

  function findBuyNowButton(event) {
    var path = event.composedPath ? event.composedPath() : [event.target];
    for (var i = 0; i < path.length; i++) {
      var el = path[i];
      if (el && el.matches && el.matches('.shopify-payment-button__button--unbranded')) return el;
    }
    return null;
  }

  function watchBuyNow() {
    document.addEventListener(
      'click',
      function (event) {
        if (buyNowBypass) return;
        var button = findBuyNowButton(event);
        if (!button) return;
        var form = button.closest('form');
        var tid = readTid();
        if (!form || !tid || !window.fetch || !window.FormData) return;

        event.preventDefault();
        event.stopImmediatePropagation();

        fetch('/cart/add.js', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { Accept: 'application/json' },
          body: new FormData(form)
        })
          .then(function (r) {
            if (!r.ok) throw new Error('add failed');
            return syncWithTimeout(tid, 3000);
          })
          .then(function () {
            window.location.href = '/checkout';
          })
          .catch(function () {
            // Something went wrong: let the original button do its normal job.
            buyNowBypass = true;
            button.click();
          });
      },
      true
    );
  }

  // fpr.js writes the cookie asynchronously, and a second affiliate link in the
  // same session replaces it a moment later. Keep watching for a while and
  // copy every new value to the cart ("last click wins").
  function syncWhenReady() {
    var tries = 0;
    var lastSeen = null;
    function check() {
      var tid = readTid();
      tries += 1;
      if (tid && tid !== lastSeen) {
        lastSeen = tid;
        syncCart(tid);
      }
      if (tries > 30) clearInterval(timer);
    }
    var timer = setInterval(check, 500);
    check(); // the cookie is often there already on later page views
  }

  // "Buy it now" / checkout can be clicked before the cart has the attribute.
  // Hold the navigation for a moment until fp_tid is stored in the cart.
  function isCheckoutForm(form, submitter) {
    if (submitter && submitter.name === 'checkout') return true;
    var action = form.getAttribute('action') || '';
    if (action.indexOf('/checkout') !== -1) return true;
    var back = form.querySelector('input[name="return_to"]');
    return !!(back && String(back.value).indexOf('checkout') !== -1);
  }

  function guardCheckout() {
    document.addEventListener(
      'submit',
      function (event) {
        var form = event.target;
        if (!form || form.tagName !== 'FORM' || form.__fprBypass) return;
        var tid = readTid();
        if (!tid || syncedTid === tid) return;
        var submitter = event.submitter;
        if (!isCheckoutForm(form, submitter)) return;
        event.preventDefault();
        syncWithTimeout(tid, 2000).then(function () {
          form.__fprBypass = true;
          if (submitter && submitter.name) {
            var hidden = document.createElement('input');
            hidden.type = 'hidden';
            hidden.name = submitter.name;
            hidden.value = submitter.value;
            form.appendChild(hidden);
          }
          HTMLFormElement.prototype.submit.call(form);
        });
      },
      true
    );

    document.addEventListener(
      'click',
      function (event) {
        var link = event.target && event.target.closest && event.target.closest('a[href*="/checkout"]');
        if (!link || event.defaultPrevented) return;
        var tid = readTid();
        if (!tid || syncedTid === tid) return;
        event.preventDefault();
        syncWithTimeout(tid, 2000).then(function () {
          window.location.href = link.href;
        });
      },
      true
    );
  }

  // Re-sync after the cart is created or changed by an AJAX add-to-cart,
  // because a cart created after page load would not have the attribute yet.
  function watchCartAdds() {
    if (!window.fetch || window.__fprFetchPatched) return;
    window.__fprFetchPatched = true;
    var original = window.fetch;
    window.fetch = function (input) {
      var result = original.apply(this, arguments);
      try {
        var url = typeof input === 'string' ? input : input && input.url;
        if (url && url.indexOf('/cart/add') !== -1) {
          result.then(function () {
            var tid = readTid();
            if (tid) syncCart(tid);
          });
        }
      } catch (e) {
        /* ignore */
      }
      return result;
    };
  }

  function start() {
    if (started) return;
    started = true;

    (function (w) {
      w.fpr =
        w.fpr ||
        function () {
          w.fpr.q = w.fpr.q || [];
          w.fpr.q[arguments[0] == 'set' ? 'unshift' : 'push'](arguments);
        };
    })(window);

    window.fpr('init', { cid: config.cid });
    window.fpr('click');

    var script = document.createElement('script');
    script.src = 'https://cdn.firstpromoter.com/fpr.js';
    script.async = true;
    document.head.appendChild(script);

    watchCartAdds();
    guardCheckout();
    watchBuyNow();
    syncWhenReady();
    window.addEventListener('pageshow', function () {
      var tid = readTid();
      if (tid && tid !== syncedTid) syncCart(tid);
    });
  }

  if (!config.respectConsent) {
    start();
  } else {
    withPrivacyApi(function (privacy) {
      // No consent API at all (e.g. no banner for this region): do not block.
      if (!privacy || marketingAllowed(privacy)) return start();
      document.addEventListener(CONSENT_EVENT, function () {
        var api = privacyApi();
        if (api && marketingAllowed(api)) start();
      });
    });
  }
})();
