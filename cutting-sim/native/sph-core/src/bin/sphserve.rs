// Local engine server: serves the page (dist/index.html) and the native solver on 127.0.0.1, so a
// browser on this machine computes with the native core instead of its own worker. Also what the
// browser tests drive. sphserve <dist/index.html> [port]
use sph_core::engine::Engine;
use tiny_http::{Header, Method, Response, Server};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let page = std::fs::read_to_string(args.get(1).map_or("dist/index.html", |s| s.as_str())).expect("read page");
    let port = args.get(2).map_or("8765", |s| s.as_str());
    // The page learns from this flag that the solver is here (src/native.js). dist/index.html is a
    // page body as published; a full document (native/app/web) gets the flag at the top of its head.
    let flag = "<script>window.__SPH_NATIVE__='http'</script>";
    let page = if page.contains("<head>") { page.replacen("<head>", &format!("<head>{flag}"), 1) }
        else { format!("<!doctype html>\n<html lang=\"ja\">\n<head>\n<meta charset=\"utf-8\">{flag}\n</head>\n<body>\n{page}\n</body>\n</html>\n") };
    let server = Server::http(format!("127.0.0.1:{port}")).expect("bind");
    eprintln!("http://127.0.0.1:{port}/  ({} threads)", rayon::current_num_threads());
    let mut eng = Engine::default();
    let ct = |v: &str| Header::from_bytes("Content-Type", v).unwrap();
    for mut rq in server.incoming_requests() {
        let url = rq.url().to_string();
        let r = match (rq.method(), url.split('?').next().unwrap_or("")) {
            (Method::Get, "/") | (Method::Get, "/index.html") => Response::from_string(page.clone()).with_header(ct("text/html; charset=utf-8")).boxed(),
            (Method::Post, "/api/init") => {
                let mut body = Vec::new();
                rq.as_reader().read_to_end(&mut body).ok();
                match eng.init(&body) {
                    Ok(n) => Response::from_string(format!("{{\"n\":{n},\"threads\":{}}}", rayon::current_num_threads())).with_header(ct("application/json")).boxed(),
                    Err(e) => Response::from_string(e).with_status_code(400).boxed(),
                }
            }
            (Method::Post, "/api/run") => {
                let ms: f64 = url.split("ms=").nth(1).and_then(|v| v.parse().ok()).unwrap_or(80.0);
                match eng.run(ms) {
                    Ok(b) => Response::from_data(b).with_header(ct("application/octet-stream")).boxed(),
                    Err(e) => Response::from_string(e).with_status_code(400).boxed(),
                }
            }
            _ => Response::from_string("not found").with_status_code(404).boxed(),
        };
        let _ = rq.respond(r);
    }
}
