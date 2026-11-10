# ![ThunderAI icon](images/icon-32px.png "ThunderAI") ThunderAI

ThunderAI is a Thunderbird Addon that uses the capabilities of ChatGPT, Google Gemini, Claude, Mistral AI or Ollama to enhance email management.

It enables users to analyse, write, correct, assign tags, create calendar events or tasks and optimize their emails, facilitating more effective and professional communication.

ThunderAI is a tool for anyone looking to improve their email quality, both in content and grammar, making the writing process quicker and more intuitive. 

You can also define, export and import your own **[custom prompts](https://micz.it/thunderbird-addon-thunderai/custom-prompts/)**!

In any custom prompt you can use additional **[data placeholders](https://micz.it/thunderbird-addon-thunderai/data-placeholders/)**!

Using an API integration, you can activate some automatic features:
- Tagging incoming emails
- Moving spam emails to the junk folder
- Sorting new mail automatically with the **Inbox Assistant**

## Inbox Assistant

Let the AI run your whole inbox, across all your accounts (toolbar button **Inbox Assistant**):
- **Sort**: every email gets a category (Needs reply, To do, Important, Receipts, Newsletters, Promotions, Notifications, Spam, or your own categories described in plain words), a priority, a one-line summary and the deadline it mentions. Apply the suggested action per category (archive, move to a folder, tag, flag, mark read, junk, trash) after a preview.
- **Clean up**: see who fills your inbox, unsubscribe in one click (RFC 8058) and archive old newsletters and old mail in bulk. No AI needed.
- **Replies & follow-ups**: emails waiting for your answer, and sent emails nobody answered, with AI drafted replies and follow-ups.
- **Inbox brief**: a short AI briefing of what needs your attention.
- **Auto-sort**: optionally classify new mail when it arrives and apply the actions of the categories you choose.
- **Safe by design**: nothing is moved without your confirmation (unless you enable auto-sort per category), protected senders, contacts and flagged mail are never moved, every action is logged and can be undone, and only a short cleaned excerpt (or just the headers) is sent to the AI.

<br>


> [!NOTE]
> **Available Integrations**
> - **ChatGPT Web**
>   - There is no need for an API key!
>   - You can use a free account!
>
> <br>
>
> - **OpenAI API**
>   - Connect directly to ChatGPT using your API key.
>
> <br>
> 
> - **Google Gemini**
>   - You can use also the _System Instructions_ and _thinkingBudget_ options if needed.
> 
> 
> <br>
> 
> - **Claude API**
>   - You need to grant the permission "_Access your data for sites in the https://anthropic.com domain_" to use the Claude API.
>
>
> <br>
>
> - **Mistral AI API**
>   - Native integration with your Mistral AI API key: model list, streaming, JSON mode, reasoning effort and automatic retries on rate limits.
>   - You can also use an **agent built in Mistral Studio** (with its own instructions, web search or document library): requests then use the Mistral Conversations API with storage disabled.
>
>
> <br>
> 
> - **Using Ollama**
>   - Just remember to add `OLLAMA_ORIGINS = moz-extension://*` to the Ollama server environment variables.
>   - [More info about CORS](https://micz.it/thunderbird-addon-thunderai/ollama-cors-information/)
>
> <br>
> 
> - **OpenAI Compatible API**
>   - You can also use a local OpenAI Compatible API server, like LM Studio or Mistral AI!
>   - There is also an option to remove the "v1" segment from the API url, if needed, and to manually set the model name if the server doesn't have a models list endpoint.
>   - You can also use one of these predefined configurations:
>     - DeepSeek API
>     - Grok API
>     - Mistral API
>     - OpenRouter API
>     - Perplexity API



<br>

## Install from source

1. Download or clone this repository, or use a packaged `.xpi` file.
2. To build the `.xpi`, zip the content of the repository root (the folder that contains `manifest.json`), for example:
   `zip -r -FS ../thunderai.xpi * -x '.git/*' '.github/*' 'claude-spec/*' 'dist/*'`
3. In Thunderbird open *Tools → Add-ons and Themes*, click the gear icon and choose *Install Add-on From File…*, then select the `.xpi`.
   For a quick test without installing, use *Tools → Developer Tools → Debug Add-ons → Load Temporary Add-on…* and select `manifest.json` (it is removed when Thunderbird restarts).
4. Open the ThunderAI options, choose **Mistral AI API** as connection type, paste your API key from [console.mistral.ai](https://console.mistral.ai) and grant the requested permission.

<br>

## Documentation

[Setup Guides](https://micz.it/thunderbird-addon-thunderai/guides/) - Step-by-step guides to connect ThunderAI to the AI backend of your choice, from ChatGPT to local models with Ollama.

[Custom Prompt Tutorial](https://micz.it/thunderbird-addon-thunderai/tutorial/) - Learn how to build your first custom prompt from scratch, combining placeholders and user input to automate your email replies.

[ThunderAI Prompt Architect](https://chatgpt.com/g/g-69b6b11c89b88191a6798be6e97025f1-thunder-ai-prompt-architect) - Let ChatGPT help you crafting your custom prompts. Thanks to [Paweł](https://github.com/PawelKinczyk) for this tool!

<br>

## Translations
Do you want to help translate this addon?

[Find out how!](https://micz.it/thunderbird-addon-thunderai/translate/)



<br>

## Changelog
ThunderAI's changes are logged [here](CHANGELOG.md).

<br>

## Privacy and Permissions
You can find all the information on [this page](https://micz.it/thunderbird-addon-thunderai/privacy-permissions/).

<br>

## Support this addon!
Are you using this addon in your Thunderbird?
<br>Consider to support the development making a small donation. [Click here!](https://www.paypal.com/donate/?business=UHN4SXPGEXWQL&no_recurring=1&item_name=Thunderbird+Addon+ThunderAI&currency_code=EUR)

<br>

## Attributions

### Translations
- Brazilian Portuguese - Português Brasileiro (pt-br): Bruno Pereira de Souza <img src="https://micz.it/weblate/thunderai/pt-br.svg">
- Chinese (Simplified) - Jiǎntǐ Zhōngwén (简体中文) (zh_Hans): [jeklau](https://github.com/jeklau), [Min9X1n](https://github.com/Min9X1n) <img src="https://micz.it/weblate/thunderai/zh_Hans.svg">
- Chinese (Traditional) - Fántǐ Zhōngwén (繁體中文) (zh_Hant): [evez](https://github.com/evez) <img src="https://micz.it/weblate/thunderai/zh_Hant.svg">
- Croatian - Hrvatski (hr): Petar Jedvaj <img src="https://micz.it/weblate/thunderai/hr.svg">
- Czech - Čeština (cs): [Fjuro](https://hosted.weblate.org/user/Fjuro/), [Jaroslav Staněk](https://hosted.weblate.org/user/jaroush/) <img src="https://micz.it/weblate/thunderai/cs.svg">
- French - Français (fr): Generated automatically, [Noam](https://github.com/noam-sc) <img src="https://micz.it/weblate/thunderai/fr.svg">
- German - Deutsch (de): Generated automatically <img src="https://micz.it/weblate/thunderai/de.svg">
- Greek - Elliniká (Ελληνικά) (el): [ChristosK.](https://github.com/christoskaterini) <img src="https://micz.it/weblate/thunderai/el.svg">
- Italian - Italiano (it): [Mic](https://github.com/micz) <img src="https://micz.it/weblate/thunderai/it.svg">
- Japanese - Nihongo (日本語) (ja): [Taichi Ito](https://github.com/watya1) <img src="https://micz.it/weblate/thunderai/ja.svg">
- Polish - Polski (pl): [neexpl](https://github.com/neexpl), [makkacprzak](https://github.com/makkacprzak) <img src="https://micz.it/weblate/thunderai/pl.svg">
- Russian - Russkiy (русский) (ru): [Maksim](https://hosted.weblate.org/user/law820314/) <img src="https://micz.it/weblate/thunderai/ru.svg">
- Spanish - Español (es): [Gerardo Sobarzo](https://hosted.weblate.org/user/gerardo.sobarzo/), [Andrés Rendón Hernández](https://hosted.weblate.org/user/arendon/), [Erick Limon](https://hosted.weblate.org/user/ErickLimonG/) <img src="https://micz.it/weblate/thunderai/es.svg">
- Swedish - Svenska (sv): [Andreas Pettersson](https://hosted.weblate.org/user/Andy_tb/), [Luna Jernberg](https://hosted.weblate.org/user/bittin1ddc447d824349b2/) <img src="https://micz.it/weblate/thunderai/sv.svg">
<br>

Do you want to help translate this addon? [Find out how!](https://micz.it/thunderbird-addon-thunderai/translate/)  <br>
_The language status represents the percentage of translated strings in the latest stable release._


<br>

### Graphics
- ChatGPT-4 for the help with the addon icon ;-)
- <a href="https://loading.io">loading.io</a> for the loading SVGs
- [Fluent Design System](https://www.iconfinder.com/fluent-designsystem) for the Custom Prompts table sorting icons
- [JessiGue](https://www.flaticon.com/authors/jessigue) for the show/hide icon for api key fields
- [Iconka.com](https://www.iconarchive.com/artist/iconka.html) for the autotag context menu icon
- [Icojam](https://www.iconarchive.com/artist/icojam.html) for the spam filter context menu icon
- [Roundicons](https://www.flaticon.com/authors/roundicons) for the summarize context menu icon
- [HideMau](https://www.flaticon.com/authors/hidemaru) for the ai summarize icon
- [Hilmy Abiyyu A.](https://www.flaticon.com/authors/hilmy-abiyyu-a) for the ai translate and context menu icons
- [bearicons](https://www.flaticon.com/authors/bearicons) for the empty context menu icon
- [meaicon](https://www.flaticon.com/authors/meaicon) for the add task context menu icon


<br>


### Miscellaneous
- <a href="https://github.com/KudoAI/chatgpt.js">chatgpt.js</a> for providing methods to interact with the ChatGPT web frontend
- <a href="https://github.com/boxabirds">Julian Harris</a> for his project <a href="https://github.com/boxabirds/chatgpt-frontend-nobuild">chatgpt-frontend-nobuild</a>, that has been used as a starting point for the API Web Interface
- <a href="https://hosted.weblate.org/widgets/thunderai/">Hosted Weblate</a> for managing the localization
