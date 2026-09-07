<div align="center">

# shekarkrishnamoorthy.com

**A personal portfolio, backed by data.**

Static HTML/CSS/JS &nbsp;•&nbsp; Two Node.js services &nbsp;•&nbsp; Apache reverse proxy &nbsp;•&nbsp; MySQL &nbsp;•&nbsp; DigitalOcean

</div>

---

## Contents

- [Overview](#overview)
- [The Collector](#the-collector)
- [The Reporting Site](#the-reporting-site)
- [The Rest of It](#the-rest-of-it)
- [Use of AI](#use-of-ai)
- [Future Issues](#future-issues)
- [My Instructions](#my-instructions)
- [Potential Flaws](#potential-flaws)

---

## Overview

Shekarkrishnamoorthy is a web site I built, hosted by a DigitalOcean droplet and served with Apache. The purpose of this website is a personal portfolio. I showcase my personality and talents on this page, witness the flow of internet DNS traffic, and gain an understanding of how I am perceived, all backed by data.

I use HTML/CSS/JS to display a static front end on top of two web-facing Node.js applications that reverse proxy to Apache. Everything is attached to a MySQL database for efficient and safe data handling. My Apache server is set up to stay clean, efficient, and handle any mess while Node.js maintains a powerful persistent process.

---

## The Collector

`collector.js` is a single self-contained IIFE served from `collector.shekarkrishnamoorthy.com` and embedded cross-origin on most sites on the domain. It gathers three categories of data: static browser data, hardware data, and mouse activity. Session identity is a random ID in `sessionStorage`. Delivery is first sent with a web beacon, then uses `fetch` as a fallback. A small public surface, `window.collector`, lets any page log one-off custom events through the same pipeline without new plumbing.

| | |
|---|---|
| ⚡ **Efficiency** | The collector script only grabs what is needed. Listeners collect at a stable rate and do not poll, and no memory is used by the web beacon. |
| 🔒 **Security** | SQL is parameterized everywhere, outputs are escaped before HTML insertion, RBAC is enforced on every site, session cookies are cleared every time and cache invalidation is tracked, IP addresses are flagged and tracked, and endpoints are size-capped and safe. |

---

## The Reporting Site

The reporting site is just an HTML shell that is run by a Node.js process. The main features of it are the authentication system, the SQL queries and aggregations, the JS visualizations, and the efficient caching to avoid the database being hammered.

---

## The Rest of It

Other than that, my project is meant to be a portfolio, where I share myself with the world. There are a few pages that I have yet to build/am in the process of building, but I want to share my projects, my interest in music, and myself.

When I track these pages, here's what I want to learn:

- Is my about page too boring?
- What is my coolest and most interesting project?!
- Is my music page too much…
- What are some things I notice about the people or bots that are visiting my page?

---

## Use of AI

I used Claude to help me a lot with this project. I gave Claude control of my GitHub, which allowed it to edit files directly. This was a fine choice with me since rolling back is always an option with GitHub. After careful preparation, I also gave it regular user SSH access to my server. It knows coding and scripting languages better than me, so allowing it to run Linux commands was a no-brainer.

**What I didn't give it:** sudo access, any pasted key, or database write access without permission — those kinds of things are finicky.

**How trust evolved over the project:**

| Stage | What I did |
|---|---|
| Early — small, basic server | Gave small, verifiable instructions. Could directly inspect every file it changed and see the front-end "prototype" it built. Read its reasoning/plans in plain English to check for hallucination. |
| Middle — more context built up | Kept giving one command at a time, but trusted it more. If a task was simple and it said everything was good, I believed it. |
| Later — complex behind the scenes | Shifted effort toward checking tasks big enough to matter but not obvious enough to catch by just looking. By this point it knew what I wanted a "finished product" to look like and built toward that directly. |

Guiding it this way let me keep control over what the project looked like and did, while making sure it stayed exactly where I wanted it at any given time — user-friendly or not.

> It's a very good tool. It is better at coding than I am, but usually likes to find bugs it already knows exist rather than think outside the box. You either have to make no mistakes when telling it what to do/code, or do the problem-solving yourself.

---

## Future Issues

One thing I would like to tackle is **APIs**. I think there are so many cool things that a web server hosted by Apache can do — web scraping and APIs are very useful. I already have a start on data tracking, but extending that to the entire internet is a big challenge. Doing so while being efficient and secure is an even bigger one.

I also want to build out my **music site** better. Right now it's just stuff, but implementing some cooler dynamic elements would be a great addition.

---

## My Instructions

My instructions are simply to explore. I want you to investigate as much as you can or want to. I put in many hours to build this website so I think it's pretty cool. Explore as much or as little as you want (the more the merrier), and then go to reporting to see what you find.

---

## Potential Flaws

The biggest thing I am concerned about is my collector script. That is the main security risk when it comes to my server. When building my website I took it one step at a time, solving problems and debugging where necessary, fixing every leak I could find. This is a problem because my scope could have zoomed past a big architectural deficiency. Because I didn't have a perfect view of what the infrastructure should look like — and didn't stray away from where I first started — I might have missed vulnerabilities, especially when it comes to transmitting data into the database.

I don't think my collect function has an exceptional rate or size limit cover, and when looking at a database that can easily overload due to direct queries, this can be bad and crash the server. It may also look internally for a problem, read some sort of JSON file it thinks should be in the database, and then I have malware on my server. Since I didn't have a good idea about the full patched security framework I need to build around rather than build through, there may be cached URLs out there that have sensitive data or leakage around my web server.
