/**
 * Every `@tauri-apps/*` module, in the web client. There is no Tauri runtime here: an async call logs
 * and rejects, a sync one throws. Desktop code already treats a rejected native call as
 * "not here" in the places web reaches. A name desktop starts importing that is missing
 * below fails the web build, so it is looked at before it ships.
 */

function unavailable(name: string) {
  return new Error(`native call unavailable on web: ${name}`);
}

function rejecting(name: string) {
  return (...args: unknown[]): Promise<never> => {
    // `invoke`'s first argument names the native command, which is what is worth knowing.
    const call = typeof args[0] === "string" ? `${name}(${args[0]})` : name;
    console.warn(unavailable(call).message);
    return Promise.reject(unavailable(call));
  };
}

function throwing(name: string) {
  return (): never => {
    throw unavailable(name);
  };
}

export const invoke = rejecting("invoke");
export const listen = rejecting("listen");
export const getCurrentWindow = throwing("getCurrentWindow");
export const getCurrentWebview = throwing("getCurrentWebview");

export class Image {
  static new = rejecting("Image.new");
}
