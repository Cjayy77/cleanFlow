ZebraMoon: Free-tier infrastructure plan

1. The recommended architecture

For ZebraMoon, I recommend keeping Firebase for authentication and the database, using Cloudflare R2 for cleaning photos, Cloudflare Workers for backend operations, and Resend for transactional emails.

The objective is to launch without paying for a traditional server, Firebase Cloud Functions, or a paid email plan.

Target infrastructure cost: $0/month initially, provided you stay within the free allowances and don’t require paid features. This is a realistic starting target, not a guarantee that every component will remain free under all circumstances.

Here’s how the services fit together.

Component	Service	Responsibility
Frontend	Your existing website	User interface, booking forms, photo selection
Authentication	Firebase Authentication	Login, registration, user identity
Database	Cloud Firestore	Bookings, users, assignments, photo metadata
Backend	Cloudflare Workers	Authorisation, secure uploads, email sending
Image storage	Cloudflare R2	Cleaning photographs
Email delivery	Resend	Booking confirmations and notifications
Scheduled deletion	R2 lifecycle rules	Automatic expiration of old photographs
Domain and DNS	Cloudflare, if already configured	zebramoon.fr and domain records

You don’t need to replace Firebase. You are adding Cloudflare services alongside it.

Official documentation:

* Firebase pricing and billing plans⁠￼
* Cloudflare Workers pricing⁠￼
* Cloudflare R2 pricing⁠￼
* Resend pricing⁠￼

⸻

2. What will everything cost?

Here is the initial budget I would use.

Service	Free allowance or price	Expected initial cost
Firebase Authentication	Standard authentication within applicable limits	$0
Firestore	1 GiB storage, 50,000 reads/day, 20,000 writes/day, 20,000 deletes/day, and 10 GiB monthly egress	$0
Cloudflare Workers	100,000 requests/day on Free	$0
Cloudflare R2	10 GB-month storage, 1 million Class A requests, 10 million Class B requests	$0
Resend	3,000 emails/month, maximum 100/day	$0
R2 lifecycle rules	No separate lifecycle-rule fee	$0
Custom domain	Already owned, if so	$0 additional
Total	Within free allowances	$0/month

Firestore’s free quotas apply to one database per project, and some features, such as managed TTL deletion and backups, require billing. 

Cloudflare’s free Worker plan includes 100,000 requests per day, but also has execution limits, including 10 ms of CPU time per invocation. 

Resend’s current Free plan allows 3,000 emails per month and 100 per day. 

Important distinction: You can avoid upgrading Firebase to Blaze for this architecture, but Cloudflare and Resend have their own account requirements and limits. Free usage isn’t a substitute for monitoring, error handling, and security.

⸻

3. Setup A: Keep Firebase on Spark

Start by keeping your existing Firebase project on the Spark plan.

You will continue using Firebase for:

* User registration and login.
* Email verification and password resets.
* Firestore database access.
* Booking and assignment records.
* User roles and application data.

The free Firestore allowance is sufficient for many small applications, although actual usage depends on how the frontend queries the database.

What you must check

Before proceeding, inspect the existing codebase for:

* Calls to Firebase Cloud Functions.
* Firebase Extensions.
* Any functionality that requires a paid Firebase feature.
* Existing Firebase Storage uploads.
* Firestore writes that directly create bookings or update sensitive statuses.

You want to know what already depends on Blaze before changing the architecture.

Do not delete or replace existing Firebase functionality until you understand its role.

Official documentation: Firebase billing plans⁠￼

⸻

4. Setup B: Create the Cloudflare R2 bucket

R2 will store the actual photographs. Firestore will store their metadata.

For example, create a private bucket named:

zebramoon-cleaning-photos

You can create it inside your existing Cloudflare account. You do not need a separate Cloudflare account just to create another R2 bucket.

Step 1: Create the bucket

In the Cloudflare dashboard:

1. Open R2 Object Storage.
2. Create a bucket.
3. Choose a suitable bucket name.
4. Keep the bucket private.
5. Configure the appropriate location options if available for your account and requirements.

Do not enable public access to cleaning photographs simply to make uploading easier.

Step 2: Configure access credentials

Create R2 credentials with the minimum permissions necessary for your application.

Keep these credentials on the backend.

Never put a permanent R2 access key or secret in frontend JavaScript.

Step 3: Set a retention policy

You want photographs deleted after 90 days.

Configure an R2 lifecycle rule that expires objects after the intended retention period.

For example, you could store images under a prefix such as:

cleaning-photos/

Then configure the lifecycle rule to expire the relevant objects.

Remember that lifecycle expiration is based on object age. If your policy requires deletion 90 days after the cleaning’s completion rather than 90 days after upload, you may need a more specific deletion workflow.

Step 4: Estimate storage

Suppose ZebraMoon completes 1,000 cleanings monthly, with 15 photographs per cleaning.

Assume each compressed photograph averages 2 MB.

* 15 photos × 2 MB = 30 MB per cleaning.
* 1,000 cleanings × 30 MB = 30 GB of new uploads monthly.
* With a 90-day retention period, steady-state storage is approximately 90 GB.

At the published R2 Standard rate of $0.015 per GB-month above the free 10 GB allowance, estimated storage costs would be:

(90 GB − 10 GB) × $0.015 = $1.20/month.

That estimate excludes request charges beyond the free allowances. R2 does not charge for internet egress. 

At lower volumes, you may remain within the 10 GB free storage allowance.

Official documentation: Cloudflare R2 pricing⁠￼

⸻

5. Setup C: Cloudflare Workers as your backend

This is the component that connects your frontend, Firebase, R2, and Resend.

A Worker is server-side code executed by Cloudflare when a request arrives. You don’t manage an always-running server.

You can build one Worker with separate endpoints, or split functionality into multiple Workers later.

I would start with a single Worker responsible for the following operations:

Endpoint	Responsibility
POST /photos/upload-url	Authorise a photo upload and generate a temporary URL
POST /photos/complete	Verify the upload and save photo metadata
GET /photos/download-url	Authorise access and generate a temporary download URL
POST /notifications/booking-confirmation	Send a booking confirmation through Resend
POST /notifications/assignment	Send an assignment notification
POST /notifications/cancellation	Send a cancellation notification

These are proposed endpoint names, not existing routes in your application.

Step 1: Create the Worker

Install and configure Cloudflare’s development tools, create a Worker project, and deploy it to your account.

Official documentation: Cloudflare Workers documentation⁠￼

Step 2: Configure secrets

The Worker may need:

* R2 credentials, if you use the S3-compatible API to generate presigned URLs.
* A Firebase service-account credential or another suitable server-side authentication mechanism for accessing Firestore.
* A Resend API key.

Store secrets using Cloudflare’s secret-management facilities.

Never expose them through frontend environment variables or public API responses.

Step 3: Connect the Worker to R2

You have two main options:

Option A: R2 binding

Configure an R2 binding so the Worker can access the bucket through Cloudflare’s native API.

This is useful for backend operations that read, write, or delete objects.

Option B: S3-compatible API and presigned URLs

Use the R2 S3-compatible API to generate presigned upload and download URLs.

This is useful when you want the browser to upload directly to R2 rather than sending image bytes through the Worker.

For ZebraMoon, I would use direct browser uploads with short-lived presigned URLs.

Official documentation: Cloudflare R2 presigned URLs⁠￼

⸻

6. How photo uploads will work

This is the complete flow from the cleaner’s perspective and from the application’s perspective.

What the cleaner sees

The cleaner opens an assigned job and sees:

Cleaning evidence

Upload at least 15 photographs.

[ Select photos ]

15 photos selected

[ Upload photos ]

The cleaner selects the photos and presses Upload.

They do not see R2, presigned URLs, or storage credentials.

What happens behind the scenes

Step 1: Authenticate the cleaner

The frontend uses Firebase Authentication.

When the cleaner requests an upload, it sends a Firebase ID token to your Worker.

Step 2: Verify permissions

The Worker validates the token and checks Firestore to establish that:

* The user is authenticated.
* The booking exists.
* The cleaner is assigned to that booking.
* The booking is in a state that permits photo uploads.
* The requested number and types of files are allowed.

This prevents a cleaner from uploading evidence to another person’s booking simply by changing a booking ID.

Step 3: Generate upload URLs

The Worker generates temporary presigned URLs for the requested objects.

The URLs grant limited access to particular objects for a limited time.

They are not permanent credentials.

Step 4: Upload directly to R2

The frontend uploads the selected images to R2 using the temporary URLs.

This means:

Browser → R2, rather than Browser → Worker → R2 for every image.

The Worker handles authorisation and URL generation, while R2 receives the actual image files.

Step 5: Record metadata

After a successful upload, the frontend notifies the Worker that the upload is complete.

The Worker verifies the relevant object and writes metadata to Firestore.

A record might contain:

{
  "bookingId": "booking_123",
  "uploadedBy": "cleaner_456",
  "objectKey": "cleaning-photos/booking_123/photo_001.jpg",
  "uploadedAt": "SERVER_TIMESTAMP",
  "contentType": "image/jpeg"
}

This is illustrative data, not a prescribed schema.

Do not rely exclusively on the frontend to declare that an upload succeeded. The backend should verify that the object exists and matches the expected constraints.

Step 6: Display the photographs

When an authorised administrator opens the booking, the frontend requests access to the relevant photos.

The Worker checks permissions and generates short-lived download URLs.

The browser displays the images.

Step 7: Delete expired images

R2’s lifecycle rule expires the objects according to the configured retention policy.

Your application should also handle the corresponding Firestore metadata so that the dashboard does not retain references to deleted files.

Important security note

Presigned URLs are bearer credentials: anyone possessing a valid URL may be able to use it for the permitted operation until it expires.

Use short expiration times, unique object keys, private buckets, and booking-level authorisation. Avoid logging full URLs where they might expose access to private evidence.

⸻

7. Setup D: Resend for transactional emails

Resend handles email delivery. It does not need to host your database.

Your application determines when an email should be sent, and Resend delivers it.

Examples include:

* Booking confirmations.
* Cleaning assignments.
* Booking cancellations.
* Service completion notifications.
* Customer receipts.
* Administrative alerts.

Resend’s Free plan currently includes 3,000 emails per month and 100 emails per day. 

Step 1: Create a Resend account

Create an account at Resend⁠￼.

Register your sending domain, preferably using a dedicated subdomain such as:

notifications.zebramoon.fr

A dedicated sending subdomain can help separate transactional mail from other uses of the domain.

Step 2: Configure DNS

Resend will provide DNS records to verify the domain and authenticate your email.

Add the required records through your DNS provider.

Typically, this includes DKIM and SPF-related configuration. Configure DMARC as appropriate for your domain and existing email setup.

Do not blindly add multiple SPF records. If your domain already has an SPF record, update it correctly rather than creating a conflicting second record.

Step 3: Create an API key

Create a Resend API key with the minimum permissions appropriate for the application.

Save it as a secret in Cloudflare Workers.

Do not place the key in the frontend.

Step 4: Create email templates

Start with a small set of templates:

* Booking confirmation.
* Cleaner assignment.
* Booking cancellation.
* Cleaning completed.
* Administrative notification.

Keep templates simple initially. You can add branding and more elaborate layouts later.

Step 5: Send emails through the Worker

When the application needs to send a notification, the Worker submits a request to Resend’s API.

For example:

POST https://api.resend.com/emails

The request contains:

* Sender.
* Recipient.
* Subject.
* HTML or text body.

Resend returns a response indicating whether it accepted the request.

Acceptance is not the same as delivery. You should monitor delivery events and handle bounces or provider failures where appropriate.

Official documentation: Resend API and pricing⁠￼

⸻

8. How Resend and Firestore will work together

This is the most important design decision for reliable notifications.

Resend does not automatically monitor Firestore changes. You need application logic to trigger the email.

There are two approaches.

Approach A: The Worker creates the booking

This is the cleaner design for new functionality.

1. The frontend submits a booking request to the Worker.
2. The Worker authenticates the customer.
3. It validates the booking details.
4. It writes the booking to Firestore.
5. It triggers the appropriate email through Resend.
6. It returns the booking result to the frontend.

The flow is:

Frontend → Worker → Firestore → Resend → recipient

However, Firestore and Resend are separate services. A booking can be saved even if email delivery fails.

For production, use an outbox or another retryable notification mechanism so the application can retry failed emails without creating duplicate bookings or sending duplicate notifications.

Approach B: The frontend creates the booking

If the existing application writes bookings directly to Firestore, you don’t necessarily need to rewrite it all immediately.

The frontend can call the Worker after a successful booking operation.

However, this is less reliable if the browser closes or the request fails before the Worker is called.

For important booking confirmations, a backend-controlled workflow or durable outbox is preferable.

My recommendation: Use a backend-controlled workflow for critical state changes, but preserve existing working functionality until you have mapped the current architecture and can migrate safely.

⸻

9. What about Firebase Authentication emails?

Firebase Authentication’s built-in verification and password-reset emails are separate from your Resend integration.

You can continue using Firebase Authentication for those messages while using Resend for ZebraMoon’s operational notifications.

That means you don’t need to replace Firebase’s authentication email functionality just to introduce Resend.

If you later want a fully customised authentication email workflow, investigate the available Firebase Authentication configuration and email-action options separately. Don’t assume that Resend automatically replaces Firebase’s built-in email delivery.

⸻

10. How to implement 90-day retention correctly

There are two separate concerns:

1. Deleting the image object from R2.
2. Removing or updating its metadata in Firestore.

R2 lifecycle rules can handle object expiration without a custom daily deletion function.

However, lifecycle expiration is not an immediate transactional operation. There may be a delay between an object reaching its expiration age and its actual deletion.

If you need the metadata to be cleaned up promptly, use a scheduled Worker or another reconciliation process.

For a straightforward policy based on upload date:

* Configure the R2 lifecycle rule.
* Store uploadedAt in Firestore.
* Store the R2 object key, not a permanent public URL.
* Ensure the application handles expired or missing objects gracefully.
* Periodically clean up stale metadata if necessary.

If you need to retain photos longer for specific disputes, a blanket 90-day lifecycle rule may be unsuitable. In that case, use a retention system that supports explicit exceptions.

⸻

11. Free-tier limitations and failure handling

The free architecture is viable, but it has limits.

Component	Important limitation	What to do
Firebase Spark	Firestore quotas and feature restrictions	Monitor reads, writes, and storage
Cloudflare Workers	100,000 requests/day and CPU limits on Free	Keep endpoints lightweight
R2	10 GB storage and operation allowances	Compress images and expire old objects
Resend	100 emails/day and 3,000/month	Track email volume
Firestore metadata	May outlive its R2 object	Reconcile expired records
Email delivery	Requests may fail or bounce	Log status and retry appropriately
Photo uploads	Clients may disconnect mid-upload	Support retries and incomplete-upload cleanup
Authentication	A valid token doesn’t prove booking access	Verify booking-level permissions
Secrets	Exposed credentials can be abused	Store them only on the backend

Cloudflare Workers’ free tier is sufficient for many small workloads, but exceeding limits or requiring features outside the free tier may require an upgrade. 

A practical failure example

Suppose a cleaner uploads 15 photographs.

Fourteen uploads succeed, and one fails because the connection drops.

Your application should not mark all 15 as successfully uploaded.

Instead, it should:

1. Record successful uploads.
2. Show the failed photograph.
3. Allow the cleaner to retry.
4. Verify the final photo count before marking the evidence complete.

Similarly, if Resend is temporarily unavailable, the booking should not disappear or be rolled back merely because the email failed.

The booking and the notification need separate error-handling paths.

⸻

12. Implementation order

I would implement the system in this order.

Phase 1: Audit the current application

Identify:

* Existing Firestore booking writes.
* Existing Firebase Storage usage.
* Current authentication and role checks.
* Any Firebase Functions or extensions.
* Existing email notifications.
* Current deployment configuration.

Do this before changing the architecture.

Phase 2: Set up R2

* Create the private bucket.
* Configure credentials.
* Establish the naming convention for objects.
* Configure the 90-day retention policy.
* Test uploads and deletions.

Phase 3: Create the Worker

* Set up the Worker project.
* Configure secrets.
* Implement Firebase ID-token verification.
* Implement booking-level permission checks.
* Add the upload-URL endpoint.
* Add the upload-completion endpoint.
* Add authorised download URLs.

Phase 4: Integrate the frontend

* Add the photo picker.
* Enforce the photo count and file-size limits.
* Compress images where appropriate.
* Upload directly to R2.
* Display progress and errors.
* Record verified metadata in Firestore.

Phase 5: Set up Resend

* Verify the sending domain.
* Configure DNS authentication.
* Create the API key.
* Store it as a Worker secret.
* Implement the email templates.
* Send a test booking confirmation.

Phase 6: Integrate notifications

* Identify the events that require email.
* Trigger emails from the backend.
* Implement retries for failed notifications.
* Prevent duplicate sends where practical.
* Monitor delivery and bounce events.

Phase 7: Test the complete workflow

Test:

* An authorised cleaner uploading 15 photographs.
* An unauthorised user attempting the same operation.
* A failed or interrupted upload.
* An administrator viewing the photos.
* An expired photo being removed.
* A booking confirmation being sent.
* Resend temporarily failing.
* A booking being saved while its email fails.
* Firestore metadata referring to an expired image.

Phase 8: Monitor usage

Check the Firebase, Cloudflare, and Resend dashboards regularly during launch.

Set alerts where available, and review usage before expanding the system.

⸻

Final recommendation

The architecture I would aim for is:

Firebase Authentication + Firestore + Cloudflare Workers + R2 + Resend.

It lets you retain Firebase as your database and authentication provider, move photographs into inexpensive object storage, and handle backend logic without Firebase Cloud Functions.

For the initial launch, you can reasonably target $0/month in infrastructure spending, provided you stay within the applicable free limits.

The main engineering cost is not the storage itself. It is implementing the integration correctly: authentication, booking-level authorisation, upload verification, notification reliability, and retention management.

One final point: if ZebraMoon is a client’s production application, keep the production infrastructure under an account the client controls wherever possible. You can retain developer access without making the business dependent on your personal Cloudflare or Resend accounts.
