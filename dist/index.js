#!/usr/bin/env node
module.exports = (() => {
  var e = {
    661: (e, r, _) => {
      _.r(r);
      const t = require("path");
      var n = _.n(t);
      const i = require("fs");
      var a = _.n(i);
      const o = require("os");
      var u = _.n(o);
      const c = process.argv;
      const s = n().resolve(c[2]);
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
      const l = () => {
        if (!a().existsSync(s)) {
          a().mkdirSync(s);
        }
        a().writeFileSync(
          n().join(s, "package.json"),
          JSON.stringify(p, null, 2) + u().EOL
        );
      };
      function run() {
        l();
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
