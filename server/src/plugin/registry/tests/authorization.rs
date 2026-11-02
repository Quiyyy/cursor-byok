use super::*;

async fn registration_fixture() -> (tempfile::TempDir, PluginRegistry) {
    let (root, registry, _store, provider) = invocation_fixture().await;
    drop(provider);
    let entry = registry.inner.entries.read().await.as_ref().unwrap()[0].clone();
    std::fs::write(&entry.entry, r#"
      import {defineProviderPlugin} from 'cursor-byok:plugin';
      defineProviderPlugin({providers:[{id:'fake',displayName:'fake',providerType:'test',resourceType:'account',invoke:async()=>({status:'completed'})}],
        resources:[{type:'account',displayName:'Account',present:r=>({displayName:r.key}),add:[{
          type:'oauth2.authorization-code',id:'browser',displayName:'Sign in',callback:{path:'/auth/callback'},
          begin:async(input)=>({session:input,authorizationUrl:'https://example.com/authorize?'+new URLSearchParams({state:input.state,redirect_uri:input.redirectUri,host:input.hostId,client:input.resource?.privateData.clientId??'new'}),expiresAtMs:Date.now()+60000}),
          register:async(session,input)=>session.resource?null:{key:input.clientId,privateData:{clientId:input.clientId},state:{status:'invalid',message:'Pending authorization'}},
          complete:async(session,input)=>{
            if(input.code==='fail') throw Error('Consent did not grant plan access');
            if(!input.codeVerifier||input.redirectUri!==session.redirectUri) throw Error('PKCE transport missing');
            return [{key:input.clientId,privateData:{clientId:input.clientId,accessToken:'fixture-access'},state:{status:'ready'}}];
          }
        }]}]});
    "#).unwrap();
    let entry = super::super::super::catalog::load_plugin(
        &entry.directory,
        registry.inner.catalog.loader(),
        &registry.executable().unwrap(),
        "1.1.4",
    )
    .await
    .unwrap();
    *registry.inner.entries.write().await = Some(vec![entry]);
    (root, registry)
}

async fn callback(
    registry: &PluginRegistry,
    begun: &OAuthBeginResponse,
    code: &str,
) -> OAuthPollResponse {
    let authorize = url::Url::parse(&begun.verification_url).unwrap();
    let values: HashMap<_, _> = authorize.query_pairs().into_owned().collect();
    let mut callback = url::Url::parse(&values["redirect_uri"]).unwrap();
    callback.query_pairs_mut().extend_pairs([
        ("state", values["state"].as_str()),
        ("code", code),
        ("client_id", "oaiapp_fixture"),
    ]);
    let browser = async {
        reqwest::Client::builder()
            .no_proxy()
            .build()
            .unwrap()
            .get(callback)
            .send()
            .await
            .unwrap()
    };
    let poll = async {
        loop {
            match registry.oauth_poll(&begun.session_id).await.unwrap() {
                OAuthPollResponse::Pending { poll_interval_ms } => {
                    tokio::time::sleep(Duration::from_millis(poll_interval_ms as u64)).await
                }
                result => break result,
            }
        }
    };
    let (_, outcome) = tokio::time::timeout(Duration::from_secs(10), async {
        tokio::join!(browser, poll)
    })
    .await
    .unwrap();
    outcome
}

#[tokio::test]
#[ignore = "requires DENO_TEST_EXECUTABLE"]
async fn registration_survives_failed_exchange_and_reconnect_selects_only_the_authorized_account() {
    let (_root, registry) = registration_fixture().await;
    let first = registry
        .oauth_begin("dev.refresh", "account", "browser", None)
        .await
        .unwrap();
    assert!(matches!(
        callback(&registry, &first, "fail").await,
        OAuthPollResponse::Failed { .. }
    ));
    let pending = registry
        .inner
        .state
        .resources("dev.refresh", "account")
        .await
        .unwrap()
        .into_iter()
        .find(|record| record.key == "oaiapp_fixture")
        .unwrap();
    assert!(matches!(
        pending.state,
        super::super::super::state::ResourceState::Invalid { .. }
    ));
    assert!(pending.private_data.get("accessToken").is_none());
    let again = registry
        .oauth_begin("dev.refresh", "account", "browser", Some(&pending.id))
        .await
        .unwrap();
    let parameters = |url: &str| {
        url::Url::parse(url)
            .unwrap()
            .query_pairs()
            .into_owned()
            .collect::<HashMap<_, _>>()
    };
    let a = parameters(&first.verification_url);
    let b = parameters(&again.verification_url);
    assert_eq!(a["host"], b["host"]);
    assert_ne!(a["state"], b["state"]);
    assert_eq!(b["client"], "oaiapp_fixture");
    assert!(matches!(
        callback(&registry, &again, "accepted").await,
        OAuthPollResponse::Completed { .. }
    ));
    assert_eq!(
        registry
            .select_resource("dev.refresh", "account")
            .await
            .unwrap()
            .id,
        pending.id
    );
    // Another ready account is not an implicit fallback after disconnect.
    registry
        .inner
        .state
        .apply_patch(
            "dev.refresh",
            "account",
            &pending.id,
            ResourcePatch {
                state: Some(super::super::super::state::ResourceStateInput::Invalid {
                    message: Some("Disconnected".into()),
                }),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(
        registry
            .select_resource("dev.refresh", "account")
            .await
            .unwrap()
            .id,
        pending.id
    );
    stop_workers(&registry).await;
}

#[tokio::test]
#[ignore = "requires DENO_TEST_EXECUTABLE"]
async fn cancelling_authorization_releases_callback_and_does_not_create_an_account() {
    let (_root, registry) = registration_fixture().await;
    let before = registry
        .inner
        .state
        .resources("dev.refresh", "account")
        .await
        .unwrap()
        .len();
    let begun = registry
        .oauth_begin("dev.refresh", "account", "browser", None)
        .await
        .unwrap();
    registry.oauth_cancel(&begun.session_id).await;
    assert!(matches!(
        registry.oauth_poll(&begun.session_id).await.unwrap(),
        OAuthPollResponse::Failed { .. }
    ));
    assert_eq!(
        registry
            .inner
            .state
            .resources("dev.refresh", "account")
            .await
            .unwrap()
            .len(),
        before
    );
    stop_workers(&registry).await;
}
