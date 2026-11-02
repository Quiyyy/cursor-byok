import { defineProviderPlugin } from "cursor-byok:plugin";
import { RESOURCE_TYPE } from "./auth.ts";
import { chatgptOAuth } from "./oauth.ts";
import { chatgptProvider } from "./provider.ts";
import { disconnectAccount, prepareAccount, presentAccount, removeAccount } from "./resources.ts";

defineProviderPlugin({
  providers: [chatgptProvider],
  resources: [{
    type: RESOURCE_TYPE,
    displayName: { "en-US": "ChatGPT registrations", "zh-CN": "ChatGPT 授权账号" },
    add: [chatgptOAuth],
    present: presentAccount,
    prepare: prepareAccount,
    actions: [disconnectAccount],
    remove: removeAccount,
  }],
});
