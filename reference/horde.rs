use futures::prelude::*;
use smol::channel;
use smol::lock::{Mutex, RwLock, OnceCell};
use smol::net::TcpStream;
use std::collections::HashMap;
use std::sync::Arc;

use async_tungstenite::tungstenite::Error;
use async_tungstenite::{async_tls::client_async_tls, tungstenite::protocol::Message};
use tinyjson::JsonValue;

use crate::JsonObject;

#[derive(Debug, Clone)]
struct Incoming {
    nonce: Option<u32>,
    value: JsonValue,
}

struct NonceInfo {
    queue: Vec<JsonValue>,
    listener: Option<RequestListener>,
}

#[derive(Debug, Clone)]
enum Credential {
    Empty,
    Token(String),
    User{username: String, password: String},
}

/// Central connection controller
struct Controller {
    nonce: std::sync::atomic::AtomicU32,
    sender: channel::Sender<Message>,
    nonce_data: Mutex<HashMap<u32, NonceInfo>>,
    credential: RwLock<Credential>,
}

/// Shareable Handle to a Horde connection
#[derive(Clone)]
pub struct Horde {
    controller: Arc<Controller>,
}

pub struct Request<'a> {
    nonce: u32,
    horde: &'a Horde,
    action: &'a str,
    body: JsonObject,
}

enum RequestListener {
    Value(channel::Sender<JsonValue>),
    Stream(channel::Sender<JsonValue>),
}

impl RequestListener {
    // Creates a Value variant, returning the receiver side
    fn value() -> (Self, channel::Receiver<JsonValue>) {
        let (sender, receiver) = channel::unbounded();
        (RequestListener::Value(sender), receiver)
    }

    // Creates a Stream variant, returning the receiver side
    fn stream() -> (Self, channel::Receiver<JsonValue>) {
        let (sender, receiver) = channel::unbounded();
        (RequestListener::Stream(sender), receiver)
    }

    // Sends data to the listener. In case of a value listener, also takes it from the option.
    // Returns whether the option had a stream to feed.
    async fn feed(opt_self: &mut Option<Self>, value: JsonValue) {
        match opt_self {
            Some(RequestListener::Stream(sender)) => {
                sender.send(value).await.unwrap();
            }
            Some(RequestListener::Value(sender)) => {
                sender.send(value).await.unwrap();
                //*opt = None;
            }
            None => panic!("Cannot feed to None"),
        }
    }
}

type SinkBox = Box<dyn Sink<Message, Error=Error> + Unpin + Send>;
enum ConnectionWriterState {
    Active(SinkBox),
    Inactive(Arc<OnceCell<()>>),
}

struct ConnectionWriter(Mutex<ConnectionWriterState>);

impl ConnectionWriter {
    async fn send (&self, msg: Message) {
        let mut guard = self.0.lock().await;
        match &mut*guard {
            ConnectionWriterState::Active(sender) => {
                // I have to clone it :(
                if let Err(_) = sender.send(msg.clone()).await {
                    // Make the connection inactive
                    let cell_arc = Arc::new(OnceCell::new());
                    *guard = ConnectionWriterState::Inactive(cell_arc.clone());

                    // Drop the reference and wait for it to become active
                    drop(guard);
                    cell_arc.wait().await;

                    // Recursively try again
                    self.send(msg);
                }
            },
            ConnectionWriterState::Inactive(..) => {
                unreachable!()
            }
        }
    }

    async fn replace (&self, sender: SinkBox) {
        let mut guard = self.0.lock().await;
        let previous = std::mem::replace(&mut*guard, ConnectionWriterState::Active(sender));

        // Signal the writer that the connection was replaced
        if let ConnectionWriterState::Inactive(cell) = previous {
            let _ = cell.set(()).await; // Signal the writer that the connection was replaced
        }
    }
}

impl Request<'_> {
    pub fn add_field(&mut self, key: &str, value: impl Into<JsonValue>) {
        self.body.insert(key.to_owned(), value.into());
    }

    /// Sends the request and returns its nonce for follow up
    async fn send_only(self) {
        let body = self.body;
        let json_payload: JsonValue = JsonValue::from(HashMap::from([
            ("nonce".to_owned(), (self.nonce as f64).into()),
            ("action".to_owned(), JsonValue::from(self.action.to_owned())),
            ("body".to_owned(), JsonValue::from(body)),
        ]));

        let text_payload = json_payload.stringify().unwrap();
        self.horde
            .controller
            .sender
            .send(Message::Text(text_payload))
            .await
            .unwrap();
    }

    pub async fn send_recv_value(self) -> JsonObject {
        let horde = self.horde;

        let (listener, recv) = RequestListener::value();
        horde.listen(self.nonce, listener).await;

        self.send_only().await;

        recv.recv().await.unwrap().try_into().unwrap()
    }

    pub async fn send_recv_stream(self) -> impl smol::stream::Stream<Item = JsonValue> {
        let horde = self.horde;

        let (listener, recv) = RequestListener::stream();
        horde.listen(self.nonce, listener).await;

        self.send_only().await;
        recv
    }

    pub async fn send_forget(self) {
        self.send_only().await;
    }
}

impl Horde {
    pub async fn connect(host: &str) -> Result<Horde, Error> {

        // Format hosts for each connection
        let ws_host = format!("{}/ws", host);
        let tcp_host = if host.starts_with("ws://") {
            host.split_at_checked(5).unwrap().1
        } else if host.starts_with("wss://") {
            host.split_at_checked(6).unwrap().1
        } else {
            &host
        }.to_owned();

        let tcp_stream = TcpStream::connect(&tcp_host).await.unwrap();
        let (ws_stream, _) = client_async_tls(&ws_host, tcp_stream).await.unwrap();
        let (ws_sender, mut ws_receiver) = ws_stream.split();

        let connection_out = Arc::new(ConnectionWriter(Mutex::new(
            ConnectionWriterState::Active(Box::new(ws_sender))
        )));

        let (sender, receiver) = channel::unbounded();

        let controller = Arc::new(Controller {
            nonce: 0.into(),
            sender,
            nonce_data: Mutex::new(HashMap::new()),
            credential: RwLock::new(Credential::Empty),
        });

        let horde = Horde { controller: controller.clone() };

        // Forward received messages to the websocket connection
        let out_clone = connection_out.clone();
        smol::spawn(async move {
            while let Ok(msg) = receiver.recv().await {
                out_clone.send(msg).await;
            }
        })
        .detach();

        let horde_clone = horde.clone();
        smol::spawn(async move {
            loop {
                {
                    // Cannot read from a stream unless it is pinned
                    // Pin it only in the context where it's receiving
                    smol::pin!(ws_receiver);

                    while let Some(Ok(msg)) = ws_receiver.next().await {
                        match msg {
                            Message::Text(text) => {
                                if let Some(incoming) = Horde::parse_incoming(&text) {
                                    let mut listeners = controller.nonce_data.lock().await;

                                    if let Some(nonce) = incoming.nonce {
                                        if let Some(info) = listeners.get_mut(&nonce) {
                                            if info.listener.is_some() {
                                                RequestListener::feed(&mut info.listener, incoming.value).await
                                            } else {
                                                info.queue.push(incoming.value);
                                            }
                                        } else {
                                            listeners.insert(
                                                nonce,
                                                NonceInfo {
                                                    queue: vec![incoming.value],
                                                    listener: None,
                                                },
                                            );
                                        }
                                    } else {
                                        // Message without nonce
                                    }
                                } else {
                                    println!("Bad message: {}", text);
                                }
                            },
                            _ => {
                                println!("Other Message: {:?}", msg);
                            }
                        }
                    }
                }

                let tcp_stream = TcpStream::connect(&tcp_host).await.unwrap();
                let (ws_stream, _) = client_async_tls(&ws_host, tcp_stream).await.unwrap();
                let (ws_sender, mut new_receiver) = ws_stream.split();

                ws_receiver = new_receiver;
                connection_out.replace(Box::new(ws_sender)).await;

                horde.auth(horde.controller.credential.read().await.clone()).await;
            }
        })
        .detach();

        Ok(horde_clone)
    }
    pub async fn with_token(host: &str, token: String) -> Result<Horde, Error> {
        let horde = Self::connect(host).await?;
        let credential = Credential::Token(token);
        horde.set_credential(credential.clone()).await;
        horde.auth(credential).await;
        Ok(horde)
    }
    pub async fn connect_user(host: &str, username: String, password: String) -> Result<Horde, Error> {
        let horde = Self::connect(host).await?;
        let credential = Credential::User{username, password};
        horde.set_credential(credential.clone()).await;
        horde.auth(credential).await;
        Ok(horde)
    }

    async fn set_credential (&self, credential: Credential) {
        let mut writer = self.controller.credential.write().await;
        *writer = credential.clone();
    }

    async fn auth (&self, credential: Credential) {
        match credential {
            Credential::Token(token) => {
                let req_obj: JsonValue = JsonObject::from([
                    ("token".to_owned(), token.into()),
                ]).into();

                let text_payload = req_obj.stringify().unwrap();
                self.controller
                    .sender
                    .send(Message::Text(text_payload))
                    .await
                    .unwrap();
            },
            Credential::User{username, password} => {
                let req_obj: JsonValue = JsonObject::from([
                    ("username".to_owned(), username.into()),
                    ("password".to_owned(), password.into()),
                ]).into();

                let text_payload = req_obj.stringify().unwrap();
                self.controller
                    .sender
                    .send(Message::Text(text_payload))
                    .await
                    .unwrap();
            },
            Credential::Empty => {
                println!("Empty credentials");
            },
        }
    }

    pub fn request<'a>(&'a self, action: &'a str) -> Request<'a> {
        Request {
            nonce: self
                .controller
                .nonce
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst),
            horde: &self,
            action,
            body: JsonObject::new(),
        }
    }

    fn parse_incoming(message: &str) -> Option<Incoming> {
        let json_parsed: JsonValue = message.parse().ok()?;

        let mut response = json_parsed.get::<JsonObject>()?.clone();
        let nonce = response.remove("nonce")
            .and_then(|jval| jval.get::<f64>().copied())
            .map(|x| x as u32);

        Some(Incoming {
            nonce, value: response.into(),
        })
    }

    async fn listen(&self, nonce: u32, listener: RequestListener) {
        let mut nonce_data = self.controller.nonce_data.lock().await;

        // Check if there are values in the queue for the specified nonce
        if let Some(info) = nonce_data.get_mut(&nonce) {
            let mut maybe_listener = Some(listener);

            if info.listener.is_some() {
                panic!("Multiple listeners for same nonce: {}", nonce);
            }

            while !info.queue.is_empty() && maybe_listener.is_some() {
                let value = info.queue.remove(0);
                RequestListener::feed(&mut maybe_listener, value).await;
            }

            info.listener = maybe_listener;
        } else {
            nonce_data.insert(
                nonce,
                NonceInfo {
                    queue: vec![],
                    listener: Some(listener),
                },
            );
        }
    }

    pub async fn handle(&self, action: &str, inputs: JsonObject) -> JsonObject {
        let mut req = self.request(action);
        req.body = inputs;

        let res = req.send_recv_value().await;
        //println!("handle response: {:?}", res);

        if let Some(message_value) = res.get("error") {
            panic!("Hanlde Error: {:?}", message_value);
        }

        return res;

        //res.get("output").unwrap().get::<JsonObject>().unwrap().clone()
    }

    pub async fn read_stream(&self, stream_id: JsonValue) -> impl Stream<Item = String> {
        let mut request = self.request("read-stream");
        request.add_field("streamId", stream_id);

        let receiver = request.send_recv_stream().await;

        async_stream::stream! {
            smol::pin!(receiver);
            while let Some(mut packet) = receiver.next().await {
                let packet_obj = packet.get_mut::<JsonObject>().unwrap();

                // Detect end of stream
                if let Some(value) = packet_obj.get("eof") {
                    if *value.get().unwrap() {
                        break;
                    }
                }

                let data = packet_obj.remove("data").unwrap();
                yield String::try_from(data).unwrap();
            }
        }
    }
}
