# Kusto MCP Server System Patterns

## System Architecture

```mermaid
flowchart TB
    Client[AI Assistant/Client] --> MCP[MCP Server Interface]
    
    subgraph Server[Kusto MCP Server]
        MCP --> Auth[Authentication Layer]
        MCP --> Tools[Tool Handlers]
        Tools --> Operations[Kusto Operations]
        Operations --> Connection[Connection Management]
        Connection --> Cache[Schema Cache]
        Connection --> Kusto[Kusto Client]
    end
    
    Auth --> Azure[Azure Services]
    Kusto --> ADX[Azure Data Explorer]
```

## Core Components

### 1. MCP Server Interface
- Implements Model Context Protocol standards
- Handles client requests and responses
- Manages tool registration and execution
- Provides structured error responses

### 2. Authentication Layer
- Supports Azure CLI and Azure Identity methods
- Manages token acquisition and renewal
- Handles authentication state
- Provides secure credential management

### 3. Tool Handlers
- initialize-connection: Cluster connection setup
- show-tables: Database table listing
- show-table: Schema retrieval
- execute-query: Query execution
- Validates input parameters
- Returns structured responses

### 4. Kusto Operations
- Connection management
- Query execution
- Schema retrieval
- Error handling
- Performance optimization

### 5. Caching Layer
- Schema caching with LRU strategy
- Cache invalidation management
- Performance optimization
- Memory usage control

## Design Patterns

### 1. Server Pattern
```mermaid
flowchart LR
    Request[Client Request] --> Validate[Validate Input]
    Validate --> Execute[Execute Operation]
    Execute --> Format[Format Response]
    Format --> Response[Send Response]
```

### 2. Authentication Pattern
```mermaid
flowchart TB
    Auth[Auth Request] --> Method{Auth Method}
    Method -->|CLI| CLI[Azure CLI]
    Method -->|Identity| Identity[Azure Identity]
    CLI --> Token[Get Token]
    Identity --> Token
    Token --> Cache[Cache Token]
    Cache --> Use[Use Token]
```

### 3. Error Handling Pattern
```mermaid
flowchart TB
    Error[Error Occurs] --> Capture[Capture Context]
    Capture --> Classify[Classify Error]
    Classify --> Format[Format Response]
    Format --> Log[Log Error]
    Format --> Return[Return to Client]
```

## Technical Decisions

### 1. TypeScript Usage
- Strong type checking
- Interface definitions
- Code organization
- Development efficiency

### 2. Dependency Choices
- @azure/identity: Azure authentication
- azure-kusto-data: Kusto operations
- @opentelemetry: Monitoring
- zod: Schema validation
- lru-cache: Caching implementation

### 3. Project Structure
```mermaid
flowchart TD
    Root[src/] --> Index[index.ts]
    Root --> Server[server.ts]
    Root --> Auth[auth/]
    Root --> Common[common/]
    Root --> Ops[operations/]
    Root --> Types[types/]
    
    Auth --> TokenCred[token-credentials.ts]
    Common --> Errors[errors.ts]
    Common --> Utils[utils.ts]
    Ops --> Kusto[kusto/]
    Types --> Config[config.ts]
    Types --> Interfaces[kusto-interfaces.ts]
```

## Communication Patterns

### 1. Request Flow
```mermaid
sequenceDiagram
    Client->>+Server: Tool Request
    Server->>+Auth: Validate Auth
    Auth-->>-Server: Auth OK
    Server->>+Operation: Execute
    Operation-->>-Server: Result
    Server-->>-Client: Response
```

### 2. Error Flow
```mermaid
sequenceDiagram
    Client->>+Server: Invalid Request
    Server->>Server: Validate
    Server->>Server: Create Error
    Server-->>-Client: Error Response
```

## Performance Patterns

### 1. Caching Strategy
- LRU cache for schemas
- Configurable cache size
- Cache invalidation rules
- Hit/miss monitoring

### 2. Query Optimization
- Parameter validation
- Query structure validation
- Result size management
- Timeout handling

## Security Patterns

### 1. Authentication Flow
- Token-based authentication
- Secure credential handling
- Token refresh management
- Error isolation

### 2. Authorization
- Azure role validation
- Operation-level checks
- Resource access control
- Error handling
