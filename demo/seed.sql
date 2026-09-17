-- Fictional sample videos for an isolated demo. No uploaded media: compositions are HTML,
-- and the footage edit is a draft waiting for the visitor's own clips.
INSERT INTO compositions (id,name,description,html,fps,created_at,updated_at) VALUES ('7c0de000-0000-4000-8000-000000000001','Open day teaser','Six-second title sequence for a fictional studio event','<div id="root" data-composition-id="launch-teaser" data-start="0" data-width="1920" data-height="1080"
     style="width:1920px;height:1080px;background:#0f172a;position:relative;overflow:hidden;font-family:Inter,system-ui,sans-serif">
  <div id="kicker" class="clip" data-start="0" data-duration="6" data-track-index="2"
       style="position:absolute;top:32%;left:50%;transform:translate(-50%,-50%);color:#5eead4;font-size:30px;font-weight:700;letter-spacing:6px;text-transform:uppercase;white-space:nowrap">
    Northlight Studio
  </div>
  <div id="title" class="clip" data-start="0.4" data-duration="5.6" data-track-index="1"
       style="position:absolute;top:48%;left:50%;transform:translate(-50%,-50%);color:#fff;font-size:104px;font-weight:800;letter-spacing:-2px;text-align:center;white-space:nowrap">
    Spring Open Day
  </div>
  <div id="date" class="clip" data-start="1.2" data-duration="4.8" data-track-index="0"
       style="position:absolute;top:62%;left:50%;transform:translate(-50%,-50%);color:#cbd5e1;font-size:38px;font-weight:500;text-align:center;white-space:nowrap">
    Every Friday in May · northlight.example.test
  </div>
  <script src="https://cdn.jsdelivr.net/npm/gsap@3/dist/gsap.min.js"></script>
  <script>
    const tl = gsap.timeline({ paused: true });
    tl.from("#kicker", { opacity: 0, y: -24, duration: 0.6 }, 0)
      .from("#title", { opacity: 0, scale: 0.92, duration: 1 }, 0.4)
      .from("#date", { opacity: 0, y: 30, duration: 0.8 }, 1.2)
      .to("#title", { opacity: 0, duration: 0.6 }, 5.2);
    window.__timelines = window.__timelines || {};
    window.__timelines["launch-teaser"] = tl;
  </script>
</div>',30,datetime('now','-2 days'),datetime('now','-2 days'));
INSERT INTO compositions (id,name,description,html,fps,created_at,updated_at) VALUES ('7c0de000-0000-4000-8000-000000000002','Speaker lower third','Name and role bar for interview footage','<div id="root" data-composition-id="lower-third" data-start="0" data-width="1920" data-height="1080"
     style="width:1920px;height:1080px;background:#1f2937;position:relative;overflow:hidden;font-family:Inter,system-ui,sans-serif">
  <div id="bar" class="clip" data-start="0.2" data-duration="4.3" data-track-index="1"
       style="position:absolute;left:120px;bottom:160px;width:760px;height:150px;background:#f8fafc;border-left:14px solid #f97316"></div>
  <div id="name" class="clip" data-start="0.5" data-duration="4" data-track-index="0"
       style="position:absolute;left:170px;bottom:238px;color:#0f172a;font-size:52px;font-weight:800;white-space:nowrap">
    Sam Rivera
  </div>
  <div id="role" class="clip" data-start="0.8" data-duration="3.7" data-track-index="0"
       style="position:absolute;left:172px;bottom:190px;color:#475569;font-size:30px;font-weight:500;white-space:nowrap">
    Head of Design, Northlight Studio
  </div>
  <script src="https://cdn.jsdelivr.net/npm/gsap@3/dist/gsap.min.js"></script>
  <script>
    const tl = gsap.timeline({ paused: true });
    tl.from("#bar", { scaleX: 0, transformOrigin: "left center", duration: 0.5 }, 0.2)
      .from("#name", { opacity: 0, x: -30, duration: 0.5 }, 0.5)
      .from("#role", { opacity: 0, x: -30, duration: 0.5 }, 0.8)
      .to(["#bar", "#name", "#role"], { opacity: 0, duration: 0.4 }, 4.1);
    window.__timelines = window.__timelines || {};
    window.__timelines["lower-third"] = tl;
  </script>
</div>',30,datetime('now','-1 days'),datetime('now','-1 days'));
INSERT INTO edit_projects (id,name,edl,brief,created_at,updated_at) VALUES ('7c0de000-0000-4000-8000-0000000000e1','Open day recap','{"version":1,"output":{"width":1280,"height":720,"fps":30,"background":"#000000"},"main":{"elements":[]},"overlays":[{"id":"overlay-1","elements":[{"id":"title-card","type":"text","text":"Northlight Studio \u00b7 Spring Open Day","startTime":0,"duration":4,"x":0.1,"y":0.42,"fontFamily":"sans","fontSize":56,"color":"#ffffff","background":"#0f172acc","align":"center"}]}],"audio":[]}','30-second recap of the open day for social media, upbeat',datetime('now','-1 days'),datetime('now','-1 days'));
