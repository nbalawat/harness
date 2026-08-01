const fs=require("fs"),path=require("path");
(async()=>{
  const port=process.argv[2];
  const demo=JSON.parse(fs.readFileSync("app/demo/slice-2.json","utf8"));
  const {chromium}=require("playwright-core");
  const browser=await chromium.launch({channel:"chrome"});
  const page=await browser.newPage({viewport:{width:1180,height:780}});
  await page.goto(`http://127.0.0.1:${port}`,{waitUntil:"load",timeout:15000});
  await page.waitForTimeout(700);
  try{
    await page.fill("#input","How do I reset a user's access?");
    await page.locator("#composer button[type=submit], #composer button").first().click();
    await page.waitForTimeout(1200);
  }catch(e){console.log("chat step skipped",String(e).slice(0,100));}
  await page.reload({waitUntil:"load"});
  await page.waitForTimeout(900);
  if((await page.locator(`#${demo.screen}`).count())===0) throw new Error("screen missing");
  for(const step of demo.steps??[]){
    if(step.action==="fill") await page.fill(step.selector,String(step.value??""));
    if(step.action==="click") await page.locator(step.selector).first().click();
    await page.waitForTimeout(500);
  }
  await page.waitForTimeout(700);
  await page.evaluate((id)=>{for(const s of document.querySelectorAll('[id^="screen-"]')){s.style.display="none";}const el=document.getElementById(id);if(el){el.style.display="block";el.style.visibility="visible";el.removeAttribute("hidden");}},demo.screen);
  await page.waitForTimeout(250);
  fs.mkdirSync("rehearsal",{recursive:true});
  await page.locator(`#${demo.screen}`).first().screenshot({path:"rehearsal/slice-2.png"});
  await browser.close();
  console.log("ok");
})().catch(e=>{console.error("FAILED",e);process.exit(1);});
