# Moving the music to a private bucket

Today anyone who has the address of a score, PDF or track can download it. After these steps the music is in its own private bucket and is served only to signed-in members, through `/api/media/…` on the app. Cover pictures stay where they are, in the public bucket.

Do the steps in order. Nothing changes for members until step 6, and step 6 can be undone until step 9.

**Status: done on the live site, 23 Nov 2026.** Bucket `sgmc-music-private`, 691 files copied, switched over at 00:36 GMT, old public copies removed the same night. `B2_PUBLIC_BASE_URL` on the VPS is now `https://media.sgmc.org.uk` (same bucket as `media.mgd.scot`). Because step 9 is done, the undo in step 8 no longer applies: see the note there. The rest of this file is kept as the record, and for doing it again elsewhere.

Placeholders used below:

| Placeholder | Meaning |
|---|---|
| `OLD` | the existing public bucket (`B2_BUCKET` in the VPS `.env`) |
| `NEW` | the new private bucket, for example `sgmc-music-private` |
| `SITE` | `https://music.sgmc.org.uk` |

## 1. Before deploying: check the public address

The default for `B2_PUBLIC_BASE_URL` in the code changed from `https://media.mgd.scot` to `https://media.sgmc.org.uk`. On the VPS:

```bash
grep B2_PUBLIC_BASE_URL ~/github/choirfriend/.env
```

- If the line is there, the deploy changes nothing. Edit it to `https://media.sgmc.org.uk` when you want cover pictures to use the new host (take effect on the next restart).
- If the line is missing, the deploy itself switches every address to `media.sgmc.org.uk`. Check first that the new host serves the same bucket: open a cover picture you know, swapping the host in its address. If it does not load, add `B2_PUBLIC_BASE_URL=https://media.mgd.scot` to `.env` before deploying.

## 2. Deploy the code

Push to `main` as usual. With no `B2_MUSIC_BUCKET` in `.env` the app behaves as it does now: same addresses, same bucket.

Check: `SITE/api/health` answers, and a song opens.

Leave a few days before step 6 if you can, so members' devices pick up the new build. It is not essential: the new service worker also covers a page that was loaded before the change.

## 3. Create the private bucket and its key

The `b2` sign-in saved on the Mac is a key limited to `OLD`, so it cannot create a bucket (`b2 bucket create` fails with "Application key is restricted to buckets"). Use the Backblaze website instead, which needs no key:

1. Buckets → Create a Bucket: name `NEW`, files **Private**, encryption and Object Lock off.
2. Application Keys → Add a New Application Key: name `choirfriend-music`, access to bucket `NEW` only, Read and Write, "Allow List All Bucket Names" ticked.
3. The page shows the `keyID` and `applicationKey` once. Keep both for steps 4 and 5.

Do not click "Generate New Master Application Key": it cancels the existing master key.

With a master or admin key the command line does the same:

```bash
b2 bucket create NEW allPrivate
b2 key create --bucket NEW choirfriend-music listBuckets,listFiles,readFiles,writeFiles,deleteFiles
```

Use the same region as `OLD`, so `B2_ENDPOINT` and `B2_REGION` stay the same. If the existing choirfriend key has a different list of capabilities, copy that list: it is known to work with the app.

## 4. Apply CORS to the new bucket

Uploads go from the browser straight to the bucket, so it needs the same upload rule.

Sign the `b2` tool in with the new key, in a separate file so the existing sign-in for `OLD` is left alone:

```bash
export B2_ACCOUNT_INFO=~/.b2_music_account_info
b2 account authorize            # asks for the key id and key from step 3

cd ~/github/choirfriend/choirfriend
./scripts/apply-b2-cors.sh NEW https://music.sgmc.org.uk http://localhost:5173
b2 bucket get NEW | jq '{bucketType, corsRules}'
```

Expect `allPrivate` and two rules, `choirfriendUploads` and `choirfriendReads`. Open a fresh terminal afterwards (or `unset B2_ACCOUNT_INFO`) to go back to the usual sign-in.

The script replaces the bucket's whole CORS list, which is fine for a new bucket. Do not run it against `OLD`.

## 5. Add the settings and copy the music

On the VPS, add to `~/github/choirfriend/.env` (do not restart yet; the running app has not read them):

```
B2_MUSIC_BUCKET=NEW
B2_MUSIC_KEY_ID=<key id from step 3>
B2_MUSIC_APPLICATION_KEY=<key from step 3>
```

### Before copying: check the download cap

The copy downloads every music file from `OLD` (691 files in November 2026; the first 414 came to 1.6 GB). That counts against the Backblaze account's **Daily Download Bandwidth** cap, which is shared by everything in the account, including the public bucket the website and the app read from. On 23 Nov 2026 the first copy used up the cap part-way through: public downloads from `OLD` were refused with a 403 "cap exceeded" for ten to fifteen minutes, so members could not load music, and 277 of the 691 files failed to copy.

So, before the `--execute` run:

- In Backblaze, Caps & Alerts: make sure the Daily Download Bandwidth cap is well above the total size of the files to copy (the dry run lists each file with its size in bytes). Raising it costs pennies. A raised cap took about five minutes to take effect.
- Or avoid the download altogether: if the originals are on a local disk, upload them to `NEW` from there instead, then run the tool to check and fill any gaps.

If the cap is hit anyway: raise it, wait until a public address answers again (`curl -sI https://media.sgmc.org.uk/music/pieces/...` gives 200, not 403), and only then rerun. Rerunning while it is still refused copies nothing.

### Copy

The tool reads from `OLD` with the existing key and writes to `NEW` with the new one. It copies only `music/pieces/` (the music), leaves `music/images/` and the website's pictures alone, and never deletes or changes anything in `OLD`.

```bash
cd ~/github/choirfriend/server
source ~/.nvm/nvm.sh && nvm use 24

node --env-file=../.env src/tools/copy-music-to-private.ts            # dry run: lists what it would copy
node --env-file=../.env src/tools/copy-music-to-private.ts --execute  # copies
```

It ends by checking every file in the database against `NEW`. You want the line "Every file in the database is in the music bucket." If it lists missing files, they are files whose objects are not in `OLD` either (already broken today); note them and carry on.

Running it again is safe: it copies only what is new.

## 6. Switch over

```bash
source ~/.nvm/nvm.sh        # pm2 lives under the default Node; do not `nvm use 24` first
pm2 restart choirfriend
```

The app is started with `--env-file=../.env`, so a plain restart rereads the file.

From now on new uploads go to `NEW`, and the app hands out `/api/media/…` addresses. If a file is somehow not in `NEW`, the app still reads it from `OLD` and logs a warning, so a missed file does not break a song.

## 7. Check

Signed out (a terminal, no cookies). Take a real address from the browser's network tab after opening a song:

```bash
curl -si SITE/api/media/pieces/<id>/files/<folder>/<name>.pdf | head -20
```

Expect `401` and `{"error":"unauthenticated"}`. Run it twice and check `cf-cache-status` is not `HIT`. If you get the file, or an HTML page from nginx, stop and undo (step 8): either an nginx `location` matching `.pdf`/`.mp3` is catching the request before `/api`, or a Cloudflare cache rule is overriding the `Cache-Control: private` the app sends.

Signed in, in the browser:

1. Open a song's sheet music.
2. Play a learning track and skip to the middle.
3. Open a flowing score.
4. Upload a small test PDF to a song, open it, delete it.
5. Open a set list cover picture (still loads from the media host).
6. On a device that had scores saved for offline use: reload, wait ten seconds, and look at the offline scores status in the menu. The saved count should be back without everything downloading again. Then switch to aeroplane mode and open a saved score.

Then on the VPS:

```bash
pm2 logs choirfriend --lines 200 --nostream | grep "not in the music bucket"
node --env-file=../.env src/tools/copy-music-to-private.ts --execute   # picks up anything uploaded between steps 5 and 6
```

No warnings after the second copy means everything is being read from `NEW`.

## 8. If something is wrong: undo

**This works only until step 9.** Once the old public copies are removed (done 23 Nov 2026), turning `B2_MUSIC_BUCKET` off would break every song, because `OLD` no longer has the files. From then on, fix forward; to go back you would first have to copy `music/pieces/` from `NEW` to `OLD`.

Before step 9: comment out `B2_MUSIC_BUCKET` in `.env` and `pm2 restart choirfriend`. The app goes back to the public addresses in `OLD`.

One catch: a file uploaded while the private bucket was on exists only in `NEW`. After undoing, it will not load until it is uploaded again or copied back by hand.

## 9. Only when you are sure: remove the old public copies

After this step `NEW` holds the only cloud copy of the music, and step 8's undo is gone, so be sure the signed-in checks in step 7 passed. A week of normal use first is the cautious choice; on 23 Nov 2026 it was done the same night, after a PDF, a flowing score and seeking in a track had been checked. Until this step the old addresses still work for anyone who has them, so this is the step that actually closes the door.

Run the copy tool one last time (step 7) and confirm it reports nothing to copy and nothing missing. Then:

```bash
b2 rm --recursive --versions --dry-run b2://OLD/music/pieces/ > removed-public-music.txt   # lists what would go; read it and keep it
b2 rm --recursive --versions b2://OLD/music/pieces/
```

Check the path twice. It must end in `music/pieces/`. `music/images/` holds the cover pictures and the bucket root holds the website's pictures; neither is touched by this command.

`--versions` removes old versions too. Without it B2 keeps hidden copies.

### Check the old addresses, and Cloudflare

Both `media.mgd.scot` and `media.sgmc.org.uk` are served through Cloudflare and are the same bucket. With an old address kept from before the move, and no cache-busting query string:

```bash
curl -sI https://media.sgmc.org.uk/music/pieces/<id>/files/<folder>/<name>.pdf | grep -i "^HTTP\|cf-cache-status"
curl -sI https://media.mgd.scot/music/pieces/<id>/files/<folder>/<name>.pdf | grep -i "^HTTP\|cf-cache-status"
```

Both should be `404`. On 23 Nov 2026 five old addresses (PDF and MP3, both hosts) gave `404` with `cf-cache-status: BYPASS` straight after the removal: Cloudflare was not keeping copies of the music, so no purge was needed.

If one still answers `200` with `cf-cache-status: HIT`, Cloudflare has a copy: in its dashboard, for the `sgmc.org.uk` and `mgd.scot` zones, Caching → Configuration → Purge Everything (purging by folder needs a paid plan), then check again.

Also check a website picture at the bucket root still loads, and `SITE/api/health` answers.

## What stays as it was

- Cover pictures: uploaded ones in `OLD` under `music/images/`, and pictures picked from the website's library at the bucket root. Public, served from whatever `B2_PUBLIC_BASE_URL` says.
- Scores already saved on a device for offline reading stay readable on that device, including after sign-out. That is the offline feature working as designed.
- Local development with no B2 settings: files are stored in `client/public/` and served by the dev server, with no sign-in check.
