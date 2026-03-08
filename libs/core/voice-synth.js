"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.speak = speak;
exports.say = say;
const platform_js_1 = require("./platform.js");
/**
 * Synthesizes speech using the OS's native TTS capabilities via Platform Abstraction.
 */
async function speak(text, options = {}) {
    await platform_js_1.platform.speak(text, options);
}
/**
 * A non-blocking wrapper to trigger speech without awaiting.
 */
function say(text, options = {}) {
    speak(text, options).catch(() => { });
}
