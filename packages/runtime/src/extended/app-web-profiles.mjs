// Browser-based services are guides only, never native "installed apps".
// No account authentication, outbound HTTP or browser action happens here.
const platforms={win32:'browser',darwin:'browser',linux:'browser'};
const entry=(id,name,host,family='browser',aliases=[])=>({
  id,category:'web',name,aliases:[name,...aliases],
  host,webFamily:family,targets:platforms,processes:{},routes:{},launchArgs:{},
});
export const WEB_APP_PROFILES=Object.freeze([
  entry('gmail-web','Gmail','mail.google.com','mail',['Gmail (web)','Google Mail']),
  entry('outlook-web','Outlook on the web','outlook.office.com','mail',['Outlook Web']),
  entry('google-calendar-web','Google Calendar','calendar.google.com','calendar'),
  entry('google-meet-web','Google Meet','meet.google.com','meeting'),
  entry('google-drive-web','Google Drive (web)','drive.google.com','files'),
  entry('google-docs-web','Google Docs','docs.google.com','documents'),
  entry('google-sheets-web','Google Sheets','sheets.google.com','documents'),
  entry('google-slides-web','Google Slides','slides.google.com','documents'),
  entry('microsoft-365-web','Microsoft 365 (web)','microsoft365.com','documents'),
  entry('onedrive-web','OneDrive (web)','onedrive.live.com','files'),
  entry('dropbox-web','Dropbox (web)','dropbox.com','files'),
  entry('slack-web','Slack (web)','app.slack.com','messaging'),
  entry('teams-web','Teams (web)','teams.microsoft.com','meeting'),
  entry('discord-web','Discord (web)','discord.com','messaging'),
  entry('telegram-web','Telegram Web','web.telegram.org','messaging'),
  entry('whatsapp-web','WhatsApp Web','web.whatsapp.com','messaging'),
  entry('zoom-web','Zoom (web)','zoom.us','meeting'),
  entry('notion-web','Notion (web)','notion.so','notes'),
  entry('trello-web','Trello','trello.com','notes'),
  entry('asana-web','Asana','app.asana.com','notes'),
  entry('jira-web','Jira','atlassian.net','notes'),
  entry('linear-web','Linear','linear.app','notes'),
  entry('github-web','GitHub (web)','github.com','coding',['GitHub']),
  entry('gitlab-web','GitLab','gitlab.com','coding'),
  entry('figma-web','Figma (web)','figma.com','graphics'),
  entry('canva-web','Canva (web)','canva.com','graphics'),
  entry('miro-web','Miro','miro.com','graphics'),
  entry('chatgpt-web','ChatGPT (web)','chatgpt.com','browser'),
  entry('claude-web','Claude (web)','claude.ai','browser'),
  entry('perplexity-web','Perplexity','perplexity.ai','browser'),
  entry('airtable-web','Airtable','airtable.com','documents'),
  entry('wordpress-web','WordPress','wordpress.com','browser'),
  entry('youtube-studio-web','YouTube Studio','studio.youtube.com','browser'),
  entry('shopify-admin-web','Shopify Admin','admin.shopify.com','browser'),
  entry('stripe-dashboard-web','Stripe Dashboard','dashboard.stripe.com','browser'),
]);
const aliases=new Map();
for(const p of WEB_APP_PROFILES){
  for(const raw of [p.id,...p.aliases]){
    const key=raw.trim().toLowerCase();
    if(aliases.has(key))throw new Error('Duplicate web app alias '+raw);
    aliases.set(key,p);
  }
}
export function findWebAppProfile(value){
  return typeof value==='string'?aliases.get(value.trim().toLowerCase())||null:null;
}
export function listWebAppProfiles(){
  return WEB_APP_PROFILES.map(p=>({
    id:p.id,category:'web',name:p.name,host:p.host,web_only:true,destinations:[],
  }));
}
