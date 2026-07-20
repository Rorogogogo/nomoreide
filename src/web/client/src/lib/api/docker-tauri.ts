/** Docker introspection shells out to the `docker` CLI either way; no Rust backend needed. */
export { httpDockerApi as tauriDockerApi } from "./docker-http.js";
