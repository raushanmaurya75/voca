# Voca - AI-Powered Writing Assistant

<div align="center">

![Voca Logo](logo.png)

**Talk Globally Professionally**

[![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-green)](https://chrome.google.com/webstore)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/Version-1.0.0-orange)](https://github.com/raushanmaurya75/voca)

*A sophisticated browser extension that helps you communicate professionally across languages with AI-powered writing assistance.*

</div>

## 🌟 Overview

Voca is an intelligent browser extension that provides real-time writing assistance, translation, and communication enhancement for professionals working across different languages and cultures. Built with modern web technologies and powered by AI, Voca seamlessly integrates into your browsing experience to help you write better, communicate more effectively, and break down language barriers.

## ✨ Key Features

### 🎯 Core Functionality
- **AI-Powered Writing Assistance**: Real-time suggestions for professional communication
- **Multi-Language Support**: 13+ languages including English, Spanish, French, German, Italian, Portuguese, Hindi, Thai, Chinese, Japanese, Korean, Arabic, and Russian
- **Smart Translation**: Context-aware translation that maintains professional tone
- **Browser Integration**: Works seamlessly across all websites and web applications

### 📊 Usage Management
- **Free Tier**: 200 messages and 80 translations per month
- **Premium Plans**: Unlimited access with advanced features
- **Real-time Usage Tracking**: Visual progress bars for message and translation quotas
- **Smart Quota Management**: Automatic reset and fair usage policies

### 🔐 Security & Privacy
- **Secure Authentication**: OAuth-based authentication via Supabase
- **Data Encryption**: End-to-end encryption for all communications
- **Privacy-First**: No data storage without explicit consent
- **GDPR Compliant**: Full compliance with data protection regulations

### 💳 Payment Integration
- **Razorpay Integration**: Secure payment processing for premium plans
- **Multiple Payment Methods**: Credit cards, debit cards, UPI, and more
- **Automated Billing**: Hassle-free subscription management
- **Transparent Pricing**: No hidden fees or charges

## 🏗️ Architecture

### Frontend (Browser Extension)
- **Manifest V3**: Latest Chrome extension standards
- **Modern UI**: Glass-morphism design with Material Design icons
- **Responsive Design**: Optimized for various screen sizes
- **Real-time Updates**: Live status indicators and usage tracking

### Backend (Cloudflare Workers)
- **Serverless Architecture**: Scalable and cost-effective
- **Edge Computing**: Global distribution for low latency
- **TypeScript**: Type-safe development environment
- **API Gateway**: RESTful API with proper authentication

### Database & Storage
- **Supabase**: PostgreSQL database with real-time capabilities
- **User Management**: Secure authentication and authorization
- **Usage Tracking**: Detailed analytics and quota management
- **Data Persistence**: Reliable data storage and backup

## 🚀 Installation & Setup

### For Users

1. **Download the Extension**
   ```bash
   # Clone the repository
   git clone https://github.com/raushanmaurya75/voca.git
   cd voca
   ```

2. **Install in Chrome**
   - Open Chrome and navigate to `chrome://extensions/`
   - Enable "Developer mode"
   - Click "Load unpacked" and select the Voca folder
   - Grant necessary permissions

3. **Sign Up/Sign In**
   - Click the Voca icon in your browser toolbar
   - Create an account or sign in with existing credentials
   - Choose your preferred speaking language
   - Start using Voca on any website!

### For Developers

#### Prerequisites
- Node.js 16+ and npm
- Chrome browser
- Git
- Cloudflare account (for backend deployment)
- Supabase account (for database)

#### Frontend Development
```bash
# Clone and setup
git clone https://github.com/raushanmaurya75/voca.git
cd voca

# Load in Chrome for development
# Navigate to chrome://extensions/ and load unpacked
```

#### Backend Development
```bash
# Navigate to backend directory
cd voca-backend

# Install dependencies
npm install

# Start development server
npm run dev

# Deploy to production
npm run deploy
```

#### Environment Setup
1. **Supabase Configuration**
   ```env
   SUPABASE_URL=your_supabase_url
   SUPABASE_ANON_KEY=your_supabase_anon_key
   ```

2. **Cloudflare Workers**
   ```env
   CLOUDFLARE_API_TOKEN=your_api_token
   CLOUDFLARE_ACCOUNT_ID=your_account_id
   ```

3. **Razorpay Integration**
   ```env
   RAZORPAY_KEY_ID=your_razorpay_key_id
   RAZORPAY_KEY_SECRET=your_razorpay_key_secret
   ```

## 📖 API Documentation

### Authentication Endpoints

#### Sign Up
```http
POST /api/auth/signup
Content-Type: application/json

{
  "email": "user@example.com",
  "password": "secure_password"
}
```

#### Sign In
```http
POST /api/auth/signin
Content-Type: application/json

{
  "email": "user@example.com",
  "password": "secure_password"
}
```

### Writing Assistant Endpoints

#### Get Writing Suggestions
```http
POST /api/writing/suggest
Authorization: Bearer <token>
Content-Type: application/json

{
  "text": "Your text here",
  "context": "email",
  "target_language": "English"
}
```

#### Translate Text
```http
POST /api/translation/translate
Authorization: Bearer <token>
Content-Type: application/json

{
  "text": "Text to translate",
  "source_language": "Spanish",
  "target_language": "English"
}
```

### Usage & Billing Endpoints

#### Get Usage Stats
```http
GET /api/usage/stats
Authorization: Bearer <token>
```

#### Create Subscription
```http
POST /api/billing/subscribe
Authorization: Bearer <token>
Content-Type: application/json

{
  "plan": "premium",
  "payment_method": "razorpay"
}
```

## 💰 Pricing Plans

### Free Plan - ₹0/month
- 200 messages per month
- 80 translations per month
- Basic writing suggestions
- 13+ language support
- Community support

### Premium Plan - ₹299/month
- Unlimited messages
- Unlimited translations
- Advanced AI suggestions
- Priority processing
- Email support
- Custom vocabulary
- Tone adjustment features

### Professional Plan - ₹599/month
- Everything in Premium
- Team collaboration
- API access
- Custom integrations
- Priority support
- Advanced analytics
- Custom training data

## 🔒 Security & Privacy

### Data Protection
- **Encryption**: All data encrypted in transit and at rest
- **Minimal Data Collection**: Only essential data is collected
- **User Control**: Users can export or delete their data anytime
- **Compliance**: GDPR, CCPA, and other privacy regulations

### Authentication & Authorization
- **OAuth 2.0**: Secure authentication flow
- **JWT Tokens**: Stateless authentication with proper expiration
- **Rate Limiting**: Protection against abuse and DDoS attacks
- **Input Validation**: Comprehensive input sanitization and validation

### Payment Security
- **PCI DSS Compliance**: Secure payment processing
- **Tokenization**: No credit card details stored
- **SSL/TLS**: All payment communications encrypted
- **Fraud Detection**: Built-in fraud prevention mechanisms

## 🛠️ Technology Stack

### Frontend
- **HTML5/CSS3**: Modern web standards
- **JavaScript (ES6+)**: Latest JavaScript features
- **Chrome Extension API**: Browser integration
- **Material Design**: UI/UX components
- **Glass-morphism**: Modern design patterns

### Backend
- **Cloudflare Workers**: Serverless computing
- **TypeScript**: Type-safe development
- **RESTful API**: Standard API design
- **JWT**: Authentication tokens
- **Edge Computing**: Global distribution

### Database & Storage
- **Supabase**: Backend-as-a-Service
- **PostgreSQL**: Relational database
- **Real-time Database**: Live data synchronization
- **Cloud Storage**: File and media storage

### Payment & Analytics
- **Razorpay**: Payment gateway
- **Webhooks**: Real-time payment notifications
- **Analytics**: Usage tracking and insights
- **Monitoring**: Performance and error tracking

## 📋 Browser Compatibility

| Browser | Version | Status |
|---------|---------|--------|
| Chrome | 88+ | ✅ Fully Supported |
| Firefox | 89+ | 🔄 In Development |
| Safari | 14+ | 🔄 Planned |
| Edge | 88+ | ✅ Fully Supported |

## 🤝 Contributing

We welcome contributions from the community! Here's how you can help:

### Development Workflow
1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

### Code Guidelines
- Follow ESLint configuration
- Write meaningful commit messages
- Add tests for new features
- Update documentation as needed
- Ensure all tests pass before submitting

### Bug Reports
- Use the issue tracker for bug reports
- Include detailed reproduction steps
- Provide browser and OS information
- Add screenshots if applicable

## 📞 Support

### Getting Help
- **Email**: support@voca.app
- **Documentation**: [Wiki](https://github.com/raushanmaurya75/voca/wiki)
- **Community**: [Discussions](https://github.com/raushanmaurya75/voca/discussions)
- **Issues**: [Bug Reports](https://github.com/raushanmaurya75/voca/issues)

### FAQ

**Q: Is my data secure?**
A: Yes, all data is encrypted and we follow industry best practices for security.

**Q: Can I use Voca offline?**
A: Basic functionality works offline, but AI features require internet connection.

**Q: How do I cancel my subscription?**
A: You can cancel anytime from your account settings or contact support.

**Q: Does Voca work on mobile browsers?**
A: Currently desktop-only, mobile version is in development.

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- **Chrome Extension Team** for excellent developer documentation
- **Supabase** for the amazing backend-as-a-service platform
- **Cloudflare** for reliable edge computing infrastructure
- **Razorpay** for seamless payment integration
- **OpenAI** for AI language model capabilities
- **Material Design** team for beautiful UI components

## 📈 Roadmap

### Version 1.1 (Q2 2024)
- [ ] Firefox support
- [ ] Advanced tone adjustment
- [ ] Team collaboration features
- [ ] Mobile browser support

### Version 1.2 (Q3 2024)
- [ ] Voice input/output
- [ ] Custom vocabulary training
- [ ] Integration with popular platforms
- [ ] Advanced analytics dashboard

### Version 2.0 (Q4 2024)
- [ ] Desktop application
- [ ] API for third-party integrations
- [ ] Enterprise features
- [ ] Advanced AI models

---

<div align="center">

**Made with ❤️ by the Voca Team**

[Website](https://voca.app) • [Twitter](https://twitter.com/vocaapp) • [LinkedIn](https://linkedin.com/company/vocaapp)

</div>
