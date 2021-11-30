#!/usr/bin/env node
module.exports = (() => {
  var e = {
    661: (e, r, _) => {
      _.r(r);
      const t = require("path");
      var n = _.n(t);
      const i = require("fs");
      var a = _.n(i);
      const u = require("os");
      var o = _.n(u);
      const c = "something";
      const p = {
        name: "app-name",
        private: true,
        scripts: {
          dev: "next dev",
          build: "next build",
          start: "next start",
          lint: "next lint",
        },
      };
      const s = () => {
        if (!a().existsSync(c)) {
          a().mkdirSync(c);
        }
        a().writeFileSync(
          n().join(c, "package.json"),
          JSON.stringify(p, null, 2) + o().EOL
        );
      };
      function run() {
        s();
      }
      run();
    },
  };
  var r = {};
  function __webpack_require__(_) {
    if (r[_]) {
      return r[_].exports;
    }
    var t = (r[_] = { exports: {} });
    var n = true;
    try {
      e[_](t, t.exports, __webpack_require__);
      n = false;
    } finally {
      if (n) delete r[_];
    }
    return t.exports;
  }
  (() => {
    __webpack_require__.n = (e) => {
      var r = e && e.__esModule ? () => e["default"] : () => e;
      __webpack_require__.d(r, { a: r });
      return r;
    };
  })();
  (() => {
    __webpack_require__.d = (e, r) => {
      for (var _ in r) {
        if (__webpack_require__.o(r, _) && !__webpack_require__.o(e, _)) {
          Object.defineProperty(e, _, { enumerable: true, get: r[_] });
        }
      }
    };
  })();
  (() => {
    __webpack_require__.o = (e, r) =>
      Object.prototype.hasOwnProperty.call(e, r);
  })();
  (() => {
    __webpack_require__.r = (e) => {
      if (typeof Symbol !== "undefined" && Symbol.toStringTag) {
        Object.defineProperty(e, Symbol.toStringTag, { value: "Module" });
      }
      Object.defineProperty(e, "__esModule", { value: true });
    };
  })();
  __webpack_require__.ab = __dirname + "/";
  return __webpack_require__(661);
})();
