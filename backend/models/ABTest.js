const mongoose = require('mongoose');

const abtestSchema = new mongoose.Schema({
  projectId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Project',
    required: true
  },
  name: String,
  active: {
    type: Boolean,
    default: false
  },
  cvCode: String,
  targetUrl: String,
  excludeUrl: String,
  startDate: Date,
  endDate: Date,
  sessionDuration: {
    type: Number,
    default: 720
  },
  conditions: {
    device: [{
      value: String,
      condition: String,
      values: [String]
    }],
    language: [{
      value: String,
      condition: String,
      values: [String]
    }],
    os: [{
      value: String,
      condition: String,
      values: [String]
    }],
    browser: [{
      value: String,
      condition: String,
      values: [String]
    }],
    other: [{
      visitCount: {
        type: String,
        default: '0'
      },
      referrer: {
        type: String,
        default: ''
      }
    }]
  },
  creatives: [{
    name: String,
    distribution: Number,
    isOriginal: {
      type: Boolean,
      default: false
    },
    css: String,
    javascript: String,
    imageUrl: String
  }],
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('ABTest', abtestSchema);