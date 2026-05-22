# 🚨 Security & Monitoring Documentation

## Current Security Features ✅

### Authentication & Session Management
| Feature | Description |
|---------|-------------|
| **PBKDF2 Password Hashing** | 210,000 iterations with SHA-256 and random salt |
| **HTTP-only Cookies** | Session tokens stored in secure, HTTP-only cookies |
| **SameSite Strict** | Prevents CSRF attacks |
| **Session Expiration** | 8-hour session timeout |
| **Secure Session Generation** | Cryptographically random 32-byte tokens |

### Input Validation & Security
| Feature | Description |
|---------|-------------|
| **Password Validation** | Minimum 6 characters required |
| **Email Validation** | Unique email constraint in database |
| **File Upload Restrictions** | Only images allowed (PNG, JPG, WebP, GIF) |
| **Request Size Limits** | 1MB for JSON, 8MB for file uploads |
| **SQL Injection Prevention** | Parameterized queries throughout |
| **Path Traversal Prevention** | File path validation for static files |

### Database Security
| Feature | Description |
|---------|-------------|
| **SQLite WAL Mode** | Write-Ahead Logging for data integrity |
| **Foreign Key Constraints** | Referential integrity enforced |
| **Unique Constraints** | Prevents duplicate usernames/emails |

## 📊 Analytics & Monitoring

### Built-in Monitoring
The server includes comprehensive monitoring capabilities:

1. **Request Logging**
   - All requests logged with timestamps
   - Performance metrics tracked per endpoint
   - Error logging with stack traces

2. **Performance Tracking**
   - Response times measured for each request
   - Endpoint-specific metrics
   - Error rate calculation

3. **Log Files** (stored in `logs/` directory)
   - `server-YYYY-MM-DD.log` - General server logs
   - `performance-YYYY-MM-DD.log` - Performance metrics (JSON format)
   - `error-YYYY-MM-DD.log` - Error logs

### Google Analytics Integration
- Optional Google Analytics tracking
- Set `GA_TRACKING_ID` in environment variables
- Automatically injected into HTML pages
- Tracks page views and user behavior

### Server Statistics Endpoint
- `GET /api/admin/stats` - Returns server statistics
- Requires admin authentication
- Provides:
  - Uptime
  - Total requests
  - Error rate
  - Per-endpoint metrics (request count, avg response time, errors)

## 📧 Email Verification (Optional)

### Configuration
Email verification is available but disabled by default. To enable:

1. Set `EMAIL_ENABLED=true` in `.env`
2. Configure SMTP settings (see `.env.example`)
3. For Gmail: Enable 2FA and generate App Password

### Email Features
- **Verification Emails** - Sent on user registration
- **Welcome Emails** - Sent after successful registration
- **HTML Templates** - Professional, branded email templates
- **Graceful Fallback** - System works even if email fails

### Email Security
- Verification tokens expire in 24 hours
- Tokens are cryptographically random
- Email verification status tracked in database

## 🔧 Database Schema

### Users Table (Enhanced)
```sql
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  email_verified INTEGER DEFAULT 0,
  email_verification_token TEXT,
  email_verification_expires INTEGER,
  role TEXT DEFAULT 'user',
  failed_login_attempts INTEGER DEFAULT 0,
  locked_until INTEGER,
  last_login INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

### New Fields Explained
- `email_verified` - Boolean (0/1) for email verification status
- `email_verification_token` - Token for email verification link
- `email_verification_expires` - Timestamp when token expires
- `role` - User role (user/admin)
- `failed_login_attempts` - Track failed login attempts
- `locked_until` - Account lockout timestamp (after 5 failed attempts)
- `last_login` - Timestamp of last successful login

## 📈 Performance Monitoring

### Metrics Tracked
- Request count per endpoint
- Average response time
- Error rate
- Server uptime
- Active user sessions

### Log Format
Performance logs are in JSON format for easy parsing:
```json
{
  "timestamp": "2026-05-08T13:30:00.000Z",
  "endpoint": "/api/cars",
  "method": "GET",
  "durationMs": 45,
  "statusCode": 200
}
```

## 🛡️ Security Best Practices

### Before Deployment
1. **Change Default Admin Password**
   ```bash
   # Set strong password in .env
   ADMIN_PASSWORD=your-very-strong-password-here
   ```

2. **Enable HTTPS**
   - Use a reverse proxy (nginx/Apache) with SSL certificates
   - Or use a service like Let's Encrypt for free SSL

3. **Set NODE_ENV=production**
   - Enables production optimizations
   - Disables verbose error messages

4. **Configure Email (Optional)**
   - Use a dedicated email service (SendGrid, Mailgun, etc.)
   - Never use personal Gmail for production

5. **Set Up Monitoring**
   - Configure Google Analytics for user tracking
   - Set up log rotation for log files
   - Monitor server resources (CPU, memory, disk)

### Ongoing Security
1. **Regular Backups**
   - Backup `inventory.db` regularly
   - Store backups securely off-site

2. **Log Monitoring**
   - Review error logs daily
   - Monitor for suspicious patterns
   - Set up alerts for high error rates

3. **Keep Dependencies Updated**
   - Node.js security patches
   - Monitor for vulnerabilities

4. **Rate Limiting** (Recommended Addition)
   - Consider adding rate limiting middleware
   - Protect against brute force attacks

## 🚀 Deployment Checklist

- [ ] Change `ADMIN_PASSWORD` to a strong, unique password
- [ ] Set `NODE_ENV=production`
- [ ] Configure HTTPS/SSL
- [ ] Set up database backups
- [ ] Configure email settings (if using email verification)
- [ ] Add Google Analytics tracking ID (if using)
- [ ] Set up log rotation
- [ ] Configure firewall rules
- [ ] Test all API endpoints
- [ ] Review and test user registration flow
- [ ] Set up monitoring/alerting

## 📝 API Endpoints

### Public Endpoints
- `GET /api/cars` - List all cars
- `POST /api/inquiries` - Submit inquiry
- `POST /api/visitors/ping` - Track visitor

### User Authentication
- `POST /api/user/register` - Register new user
- `POST /api/user/login` - User login
- `POST /api/user/logout` - User logout
- `GET /api/user/session` - Check user session
- `GET /api/user/verify-email` - Verify email (query: `?token=xxx`)
- `POST /api/user/resend-verification` - Resend verification email

### Admin Endpoints (Require Authentication)
- `POST /api/admin/login` - Admin login
- `POST /api/admin/logout` - Admin logout
- `GET /api/admin/session` - Check admin session
- `GET /api/admin/cars` - List cars (admin view)
- `POST /api/admin/cars` - Add new car
- `DELETE /api/admin/cars/:id` - Delete car
- `GET /api/admin/inquiries` - List inquiries
- `GET /api/admin/visitors` - List visitors
- `GET /api/admin/active-users` - List active user sessions
- `GET /api/admin/users` - List all users
- `GET /api/admin/stats` - Get server statistics

## 🔍 Troubleshooting

### Email Not Sending
1. Check `EMAIL_ENABLED=true` in `.env`
2. Verify SMTP credentials are correct
3. For Gmail: Ensure 2FA is enabled and App Password is used
4. Check firewall allows outbound connections on port 587

### Database Migration Issues
If you see schema errors, the database will auto-migrate on startup. To force migration:
1. Delete `inventory.db` (backup first!)
2. Restart the server

### Performance Issues
1. Check `logs/performance-*.log` for slow endpoints
2. Monitor database size
3. Consider adding indexes for frequently queried fields
4. Check server resources (CPU, memory)

## 📞 Support

For issues or questions:
1. Check the logs in `logs/` directory
2. Review this documentation
3. Test API endpoints individually
4. Verify environment variables are set correctly