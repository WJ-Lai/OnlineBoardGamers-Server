FROM python:3.13-alpine

RUN apk add --no-cache mariadb-connector-c-dev
RUN apk add --no-cache --virtual build-deps gcc musl-dev pkgconf mariadb-dev

RUN apk add --no-cache mysql-client nodejs npm

# Set environment variables
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

# Set the working directory
WORKDIR /app

# Install dependencies
COPY requirements.txt /app/
RUN pip install -r requirements.txt
# Install development dependencies - remove this line for production builds
COPY requirements-dev.txt /app/
RUN pip install -r requirements-dev.txt

# Copy the project code into the container
COPY . /app/

# The Agent API executes the existing FCM Vue rules in an isolated Node worker.
RUN cd /app/FCM/vueFCM && npm ci \
    && cd /app/mcp-server && npm ci --omit=dev

CMD ./start.sh
